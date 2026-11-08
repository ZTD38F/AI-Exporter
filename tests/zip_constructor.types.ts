import { __getZipConstructor, __setZipConstructor, type ZipConstructor } from '../src/l4/packaging/writers/zipWriter.js';

function zipInjectionContract(): void {
    const previous: ZipConstructor | undefined = __getZipConstructor();
    __setZipConstructor(class { file() {} async generateAsync() { return new Blob(); } });
    __setZipConstructor(previous);
    // @ts-expect-error A module name cannot select an arbitrary injected value.
    __setZipConstructor('JSZip', {});
    // @ts-expect-error An injected constructor must implement the writer's file operation.
    __setZipConstructor(class { async generateAsync() { return new Blob(); } });
    // @ts-expect-error ZIP generation must return a Blob, not arbitrary data.
    __setZipConstructor(class { file() {} async generateAsync() { return 'archive'; } });
    // @ts-expect-error Consumers cannot choose an unrelated return type.
    __getZipConstructor<string>();
}
void zipInjectionContract;
