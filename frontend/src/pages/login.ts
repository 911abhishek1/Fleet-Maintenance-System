import { authAPI } from '../api';
import { setAuth } from '../state';
import { navigate } from '../router';
import { toastSuccess, toastError } from '../components/toast';

export function renderLoginPage(container: HTMLElement): void {
  let mode: 'login' | 'register' = 'login';

  function render() {
    container.innerHTML = `
      <div class="login-page">
        <div class="login-card">
          <div class="login-header">
            <div class="login-icon">🚛</div>
            <h1>FleetPro</h1>
            <p>${mode === 'login' ? 'Sign in to your account' : 'Create a new account'}</p>
          </div>
          <div class="login-body">
            <div class="login-toggle">
              <button class="${mode === 'login' ? 'active' : ''}" id="toggle-login">Sign In</button>
              <button class="${mode === 'register' ? 'active' : ''}" id="toggle-register">Register</button>
            </div>

            <div id="login-error" class="login-error" style="display:none;"></div>

            <form id="auth-form">
              <div class="form-group">
                <label class="form-label" for="email">Email</label>
                <input type="email" id="email" class="form-input" placeholder="you@company.com" required autocomplete="email" />
              </div>

              <div class="form-group">
                <label class="form-label" for="password">Password</label>
                <input type="password" id="password" class="form-input" placeholder="••••••••" required minlength="6" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" />
              </div>

              ${mode === 'register' ? `
              <div class="form-group">
                <label class="form-label" for="role">Role</label>
                <select id="role" class="form-select" required>
                  <option value="FLEET_MANAGER">Fleet Manager</option>
                  <option value="TECHNICIAN">Technician</option>
                </select>
              </div>
              ` : ''}

              <button type="submit" class="btn btn-primary btn-lg" style="width:100%;" id="submit-btn">
                ${mode === 'login' ? 'Sign In' : 'Create Account'}
              </button>
            </form>
          </div>
        </div>
      </div>
    `;

    // Toggle handlers
    document.getElementById('toggle-login')!.addEventListener('click', () => {
      mode = 'login';
      render();
    });
    document.getElementById('toggle-register')!.addEventListener('click', () => {
      mode = 'register';
      render();
    });

    // Form submit
    document.getElementById('auth-form')!.addEventListener('submit', handleSubmit);
  }

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const errorEl = document.getElementById('login-error')!;
    const submitBtn = document.getElementById('submit-btn') as HTMLButtonElement;
    const email = (document.getElementById('email') as HTMLInputElement).value.trim();
    const password = (document.getElementById('password') as HTMLInputElement).value;

    errorEl.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span>';

    try {
      if (mode === 'register') {
        const role = (document.getElementById('role') as HTMLSelectElement).value;
        await authAPI.register(email, password, role);
        toastSuccess('Account created', 'You can now sign in.');
        mode = 'login';
        render();
        return;
      }

      const res = await authAPI.login(email, password);
      const { token, user } = res.data;
      setAuth(token, user);
      toastSuccess('Welcome back!', `Signed in as ${user.email}`);
      navigate('/dashboard');
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      const message = axiosErr.response?.data?.error ?? 'Something went wrong';
      errorEl.textContent = message;
      errorEl.style.display = 'block';
      toastError('Authentication failed', message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = mode === 'login' ? 'Sign In' : 'Create Account';
    }
  }

  render();
}
