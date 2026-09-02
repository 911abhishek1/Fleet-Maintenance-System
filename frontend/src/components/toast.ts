let toastContainer: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    toastContainer.id = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  return toastContainer;
}

type ToastType = 'success' | 'error' | 'info' | 'warning';

const ICONS: Record<ToastType, string> = {
  success: '✓',
  error: '✕',
  info: 'ℹ',
  warning: '⚠',
};

export function showToast(
  title: string,
  message: string = '',
  type: ToastType = 'info',
  duration: number = 4000
): void {
  const container = ensureContainer();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${ICONS[type]}</span>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      ${message ? `<div class="toast-message">${message}</div>` : ''}
    </div>
    <button class="toast-dismiss" aria-label="Dismiss">✕</button>
    <div class="toast-progress" style="animation-duration: ${duration}ms"></div>
  `;

  const dismiss = () => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 250);
  };

  toast.querySelector('.toast-dismiss')!.addEventListener('click', dismiss);

  container.appendChild(toast);

  setTimeout(dismiss, duration);
}

export function toastSuccess(title: string, message?: string): void {
  showToast(title, message, 'success');
}

export function toastError(title: string, message?: string): void {
  showToast(title, message, 'error', 6000);
}

export function toastInfo(title: string, message?: string): void {
  showToast(title, message, 'info');
}

export function toastWarning(title: string, message?: string): void {
  showToast(title, message, 'warning', 5000);
}
