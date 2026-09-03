import axios from 'axios';
import { getToken } from './state';

const API_BASE = 'http://localhost:5000/api';

const api = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
});

// Attach auth token to every request
api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Redirect to login on 401
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      if (window.location.hash !== '#/login') {
        window.location.hash = '#/login';
      }
    }
    return Promise.reject(error);
  }
);

// --- Auth ---
export const authAPI = {
  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),

  register: (email: string, password: string, role: string) =>
    api.post('/auth/register', { email, password, role }),

  logout: () => api.post('/auth/logout'),

  getTechnicians: () => api.get('/auth/technicians'),
};

// --- Vehicles ---
export const vehicleAPI = {
  list: async (params?: {
    page?: number;
    limit?: number;
    search?: string;
    archived?: boolean | string;
    sortBy?: string;
    sortOrder?: string;
  }) => {
    const res = await api.get('/vehicles', { params });
    if (res.data && Array.isArray(res.data.vehicles)) {
      const arr = [...res.data.vehicles] as any;
      arr.vehicles = res.data.vehicles;
      arr.records = res.data.records;
      arr.total = res.data.total;
      arr.totalPages = res.data.totalPages;
      arr.page = res.data.page;
      arr.limit = res.data.limit;
      res.data = arr;
    }
    return res;
  },

  create: (data: {
    registration: string;
    make: string;
    model: string;
    odometer: number;
    dateIntervalDays: number;
    mileageInterval: number;
  }) => api.post('/vehicles', data),

  update: (id: string, data: Record<string, unknown>) =>
    api.put(`/vehicles/${id}`, data),

  archive: (id: string, archived: boolean) =>
    api.patch(`/vehicles/${id}/archive`, { archived }),

  bulkOdometer: (payload: FormData | { csv: string } | string) => {
    if (payload instanceof FormData) {
      return api.post('/vehicles/bulk-odometer', payload);
    }
    const body = typeof payload === 'string' ? { csv: payload } : payload;
    return api.post('/vehicles/bulk-odometer', body);
  },

  evaluateStatus: (gracePeriodDays?: number) =>
    api.post('/vehicles/evaluate-status', { gracePeriodDays }),
};

// --- Services ---
export const serviceAPI = {
  list: () => api.get('/services'),

  search: (params: {
    page?: number;
    limit?: number;
    description?: string;
    vehicleId?: string;
    status?: string;
    technicianId?: string;
    sortBy?: string;
    sortOrder?: string;
  }) => api.get('/services/search', { params }),

  create: (data: {
    vehicleId: string;
    description: string;
    status?: string;
  }) => api.post('/services', data),

  update: (id: string, data: Record<string, unknown>) =>
    api.put(`/services/${id}`, data),

  assignTechnician: (serviceId: string, technicianId: string) =>
    api.post(`/services/${serviceId}/assignments`, { technicianId }),

  removeTechnician: (serviceId: string, technicianId: string) =>
    api.delete(`/services/${serviceId}/assignments/${technicianId}`),

  exportCSV: () =>
    api.get('/services/export-csv', { responseType: 'blob' }),
};

// --- Alerts ---
export const alertAPI = {
  list: () => api.get('/alerts'),
  dismiss: (serviceRecordId: string) =>
    api.post(`/alerts/${serviceRecordId}/dismiss`),
};

export default api;
