#!/usr/bin/env python3
"""Launch isolated Chrome without desktop windows; use --headed for manual login."""
import argparse
import errno
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scripts.chrome_diagnostics import browser_version, timestamp
from scripts.cdp_client import CDPConnection


def ensure_port_free(port):
    # Check the actual listening address without allocating an outbound ephemeral
    # port. connect_ex can return EADDRNOTAVAIL under local port pressure even
    # when the target is occupied, which used to incorrectly authorize launch.
    with socket.socket() as probe:
        try:
            probe.bind(('127.0.0.1', port))
        except OSError as error:
            if error.errno != errno.EADDRINUSE:
                raise
            raise RuntimeError(f'Port {port} is already occupied. Use the existing test browser '
                               'or quit it normally before launching again; no process was killed.') from error


def ensure_profile_free(profile):
    singleton = profile / 'SingletonLock'
    if singleton.is_symlink():
        try:
            owner_host, owner_pid = os.readlink(singleton).rsplit('-', 1)
            if owner_host != socket.gethostname():
                raise RuntimeError('Test profile has a lock from another host; inspect it before launching')
            os.kill(int(owner_pid), 0)  # Existence probe only; sends no termination signal.
        except ProcessLookupError:
            return  # Let Chrome recover its own stale singleton; never delete profile files here.
        except (ValueError, PermissionError) as error:
            raise RuntimeError('Cannot verify test profile lock owner') from error
        raise RuntimeError('Test profile is already in use; quit its Chrome normally first')
    if singleton.exists():
        raise RuntimeError('Unrecognized test profile lock; inspect it before launching')


def verify_process(version, pid):
    connection = CDPConnection(version['webSocketDebuggerUrl'])
    try:
        result = connection.call('SystemInfo.getProcessInfo', timeout=2)
        processes = result.get('result', {}).get('processInfo', [])
        if not any(item.get('type') == 'browser' and item.get('id') == pid for item in processes):
            raise RuntimeError('Debug endpoint belongs to another process; refusing to claim its logs')
    finally:
        connection.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chrome', required=True)
    parser.add_argument('--profile', required=True)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--port', type=int, default=9222)
    parser.add_argument('--headed', action='store_true',
                        help='Open desktop windows for manual login/debugging (can take focus)')
    args, extra = parser.parse_known_args(argv)
    extra = extra[1:] if extra[:1] == ['--'] else extra
    # Shell/PowerShell/CMD wrappers forward Chrome arguments after '--'. Accept
    # the explicit login escape hatch there too, without passing it to Chrome.
    headed = args.headed or '--headed' in extra
    extra = [arg for arg in extra if arg != '--headed']
    headless = [arg for arg in extra if arg == '--headless' or arg.startswith('--headless=')]
    if headed and headless:
        parser.error('--headed cannot be combined with --headless')
    if any(arg not in ('--headless', '--headless=new') for arg in headless):
        parser.error('Only unified --headless=new is supported for background tests')
    extra = [arg for arg in extra if arg not in headless]
    display_args = [] if headed else ['--headless=new']
    # Keep the identity and log paths controlled by this launcher.
    reserved = ('--user-data-dir', '--remote-debugging', '--log-file', '--enable-logging',
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security')
    if any(arg.startswith(reserved) for arg in extra):
        parser.error('Profile, debug endpoint and log flags are managed by the launcher')
    profile = Path(args.profile).resolve()
    profile.mkdir(parents=True, exist_ok=True)
    lock = profile / '.chrome-launch.lock'
    try:
        # Exclusive creation serializes simultaneous launch attempts. No stale-lock deletion.
        with lock.open('x') as stream:
            stream.write(str(os.getpid()))
    except FileExistsError:
        parser.error(f'Launch already in progress, or stale launcher lock: {lock}')
    try:
        ensure_port_free(args.port)
        # Chrome's own profile singleton protects running profiles on another port.
        ensure_profile_free(profile)
        log_dir = profile / 'diagnostics' / (datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S') + f'-{os.getpid()}')
        log_dir.mkdir(parents=True)
        command = [args.chrome, f'--user-data-dir={profile}', f'--load-extension={Path(args.repo).resolve()}',
                   f'--remote-debugging-port={args.port}', '--remote-debugging-address=127.0.0.1',
                   '--enable-unsafe-extension-debugging',
                   '--no-first-run', '--no-default-browser-check', '--enable-logging',
                   f'--log-file={log_dir / "chrome.log"}', *display_args, *extra]
        metadata = dict(started_at=timestamp(), mode='headed' if headed else 'headless',
                        command=command, profile=str(profile),
                        log_dir=str(log_dir), browser=None)

        def save():
            text = json.dumps(metadata, ensure_ascii=False, indent=2)
            (log_dir / 'launch.json').write_text(text, encoding='utf-8')
            temporary = profile / 'chrome-launch.tmp'
            temporary.write_text(text, encoding='utf-8')
            temporary.replace(profile / 'chrome-launch.json')

        with (log_dir / 'stderr.log').open('ab') as log:
            # Detach from the invoking shell's process group. Test cleanup only disconnects CDP.
            detach = ({'creationflags': subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
                      if os.name == 'nt' else {'start_new_session': True})
            process = subprocess.Popen(command, stdout=log, stderr=log, **detach)
        metadata['pid'] = process.pid
        save()
        for _ in range(100):
            if process.poll() is not None:
                metadata['exit_code'] = process.returncode
                save()
                raise RuntimeError(f'Chrome exited during startup ({process.returncode}); logs: {log_dir}')
            try:
                version = browser_version(args.port)
                verify_process(version, process.pid)
                metadata['browser'] = version
                save()
                print('Desktop windows enabled (manual login/debugging).' if headed else
                      'Background Chrome: no desktop windows; CDP screenshots and input remain available.', flush=True)
                print(f'Chrome PID {process.pid}; diagnostic logs: {log_dir}', flush=True)
                return 0
            except (OSError, ValueError, RuntimeError):
                time.sleep(.1)
        raise RuntimeError(f'Chrome did not expose port {args.port}; logs: {log_dir}. '
                           'Inspect the running process before launching again.')
    finally:
        lock.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, RuntimeError) as error:
        print(f'Chrome launch failed: {error}', file=sys.stderr)
        sys.exit(1)
