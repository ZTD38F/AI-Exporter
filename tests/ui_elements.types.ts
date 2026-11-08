import { elementById, requiredElement } from '../src/ui/shared/elements.js';

function elementContracts(): void {
    requiredElement('input', 'checkbox').checked = true;
    requiredElement('select', 'format').value = 'json';
    requiredElement('dialog', 'confirmation').showModal();
    // @ts-expect-error A button cannot acquire checkbox state from a caller-selected type.
    requiredElement('button', 'action').checked = true;
    // @ts-expect-error A select cannot acquire checkbox state.
    requiredElement('select', 'format').checked = true;
    // @ts-expect-error A plain ID lookup does not establish a specific element subtype.
    elementById('format').value = 'json';
    // @ts-expect-error Callers choose an actual tag, not an arbitrary DOM subtype.
    requiredElement<HTMLInputElement>('button', 'action');
}
void elementContracts;
