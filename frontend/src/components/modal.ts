export function openModal(title: string, bodyHTML: string, footerHTML: string = ''): HTMLElement {
  // Remove any existing modal
  closeModal();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'modal-overlay';

  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2>${title}</h2>
        <button class="modal-close" aria-label="Close modal">✕</button>
      </div>
      <div class="modal-body">${bodyHTML}</div>
      ${footerHTML ? `<div class="modal-footer">${footerHTML}</div>` : ''}
    </div>
  `;

  document.body.appendChild(overlay);

  // Animate in
  requestAnimationFrame(() => overlay.classList.add('open'));

  // Close on backdrop click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  // Close on X button
  overlay.querySelector('.modal-close')!.addEventListener('click', closeModal);

  // Close on Escape key
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeModal();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);

  return overlay;
}

export function closeModal(): void {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 250);
  }
}

export function getModalBody(): HTMLElement | null {
  return document.querySelector('#modal-overlay .modal-body');
}

export function getModalFooter(): HTMLElement | null {
  return document.querySelector('#modal-overlay .modal-footer');
}
