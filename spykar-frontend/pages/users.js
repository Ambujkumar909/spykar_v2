import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  UserCog,
  Shield,
  Search,
  Plus,
  Pencil,
  Power,
  RefreshCw,
  UserPlus,
} from 'lucide-react';
import DashboardLayout from '../components/layout/DashboardLayout';
import KpiCard from '../components/ui/KpiCard';
import { authService } from '../lib/services';
import { useAuth } from '../lib/auth-context';
import { formatDateTime, formatNumber } from '../lib/utils';
import toast from 'react-hot-toast';

const ROLE_OPTIONS = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'VIEWER'];

const ROLE_BADGES = {
  SUPER_ADMIN: 'badge-violet',
  ADMIN: 'badge-danger',
  MANAGER: 'badge-warning',
  VIEWER: 'badge-success',
};

const ROLE_COLOR_KEYS = {
  SUPER_ADMIN: 'violet',
  ADMIN: 'rose',
  MANAGER: 'amber',
  VIEWER: 'emerald',
};

const EMPTY_CREATE_FORM = {
  name: '',
  email: '',
  password: '',
  role: 'MANAGER',
};

export default function UsersPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(EMPTY_CREATE_FORM);
  const [editUser, setEditUser] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', role: 'VIEWER', is_active: true });
  const [submitting, setSubmitting] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authService.listUsers({
        search: search || undefined,
        role: roleFilter || undefined,
        limit: 100,
      });
      setUsers(res.data.data || []);
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [search, roleFilter]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const metrics = useMemo(() => {
    const activeCount = users.filter((entry) => entry.is_active).length;
    const adminCount = users.filter((entry) => ['SUPER_ADMIN', 'ADMIN'].includes(entry.role)).length;
    const recentLogins = users.filter((entry) => entry.last_login_at).length;

    return { total: users.length, activeCount, adminCount, recentLogins };
  }, [users]);

  function openEditModal(targetUser) {
    setEditUser(targetUser);
    setEditForm({
      name: targetUser.name || '',
      role: targetUser.role || 'VIEWER',
      is_active: Boolean(targetUser.is_active),
    });
  }

  function closeModals() {
    setIsCreateOpen(false);
    setCreateForm(EMPTY_CREATE_FORM);
    setEditUser(null);
    setEditForm({ name: '', role: 'VIEWER', is_active: true });
  }

  async function handleCreateUser(event) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await authService.createUser(createForm);
      toast.success('User created successfully');
      closeModals();
      fetchUsers();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Failed to create user');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpdateUser(event) {
    event.preventDefault();
    if (!editUser) return;

    setSubmitting(true);
    try {
      await authService.updateUser(editUser.id, {
        name: editForm.name,
        role: editForm.role,
        is_active: editForm.is_active,
      });
      toast.success('User updated successfully');
      closeModals();
      fetchUsers();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Failed to update user');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleUser(targetUser) {
    if (user?.role !== 'SUPER_ADMIN') {
      toast.error('Only Super Admin can change activation state');
      return;
    }

    try {
      await authService.toggleUser(targetUser.id);
      toast.success(targetUser.is_active ? 'User deactivated' : 'User reactivated');
      fetchUsers();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Failed to change user status');
    }
  }

  return (
    <DashboardLayout
      title="User Management"
      subtitle="Provision, govern and monitor access across the Spykar IQ control plane"
      allowedRoles={['SUPER_ADMIN', 'ADMIN']}
    >
      <div className="grid-4" style={{ marginBottom: 24 }}>
        <KpiCard label="Total Users" value={metrics.total} icon={UserCog} colorKey="violet" loading={loading} />
        <KpiCard label="Active Users" value={metrics.activeCount} icon={Shield} colorKey="emerald" loading={loading} />
        <KpiCard label="Admin Coverage" value={metrics.adminCount} icon={UserPlus} colorKey="rose" loading={loading} />
        <KpiCard label="Logged In Before" value={metrics.recentLogins} icon={RefreshCw} colorKey="sky" loading={loading} />
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <span className="card-title">Directory Controls</span>
          <div className="filter-bar">
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                className="input"
                placeholder="Search name or email"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                style={{ paddingLeft: 30, width: 240 }}
              />
            </div>
            <select className="input" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} style={{ width: 170 }}>
              <option value="">All Roles</option>
              {ROLE_OPTIONS.map((role) => (
                <option key={role} value={role}>{role.replace(/_/g, ' ')}</option>
              ))}
            </select>
            <button type="button" className="btn btn-ghost" onClick={fetchUsers}>
              <RefreshCw size={14} />
              Refresh
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setIsCreateOpen(true)}>
              <Plus size={14} />
              Add User
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Access Directory</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{formatNumber(users.length)} records</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last Login</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && Array.from({ length: 6 }).map((_, index) => (
                <tr key={index}>
                  <td colSpan={5}><div className="skeleton" style={{ height: 44 }} /></td>
                </tr>
              ))}

              {!loading && users.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{entry.name}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{entry.email}</span>
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${ROLE_BADGES[entry.role] || 'badge-neutral'}`}>
                      {entry.role.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${entry.is_active ? 'badge-success' : 'badge-danger'}`}>
                      {entry.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td>{formatDateTime(entry.last_login_at)}</td>
                  <td>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <button type="button" className="btn btn-ghost" onClick={() => openEditModal(entry)}>
                        <Pencil size={14} />
                        Edit
                      </button>
                      {user?.role === 'SUPER_ADMIN' && (
                        <button
                          type="button"
                          className={`btn ${entry.is_active ? 'btn-danger' : 'btn-ghost'}`}
                          onClick={() => handleToggleUser(entry)}
                        >
                          <Power size={14} />
                          {entry.is_active ? 'Deactivate' : 'Reactivate'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}

              {!loading && !users.length && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">
                      <UserCog size={32} />
                      <p>No users matched the current filters.</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {(isCreateOpen || editUser) && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(10, 10, 15, 0.76)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          zIndex: 220,
          backdropFilter: 'blur(10px)',
        }}>
          <div className="card" style={{ width: '100%', maxWidth: 520 }}>
            <div className="card-header">
              <span className="card-title">{editUser ? 'Edit User' : 'Create User'}</span>
              <button type="button" className="btn btn-ghost" onClick={closeModals}>Close</button>
            </div>

            <form onSubmit={editUser ? handleUpdateUser : handleCreateUser} className="card-body" style={{ display: 'grid', gap: 14 }}>
              <div>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 12, color: 'var(--text-muted)' }}>Name</label>
                <input
                  className="input"
                  value={editUser ? editForm.name : createForm.name}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (editUser) setEditForm((current) => ({ ...current, name: value }));
                    else setCreateForm((current) => ({ ...current, name: value }));
                  }}
                  required
                />
              </div>

              {!editUser && (
                <>
                  <div>
                    <label style={{ display: 'block', marginBottom: 6, fontSize: 12, color: 'var(--text-muted)' }}>Email</label>
                    <input
                      className="input"
                      type="email"
                      value={createForm.email}
                      onChange={(event) => setCreateForm((current) => ({ ...current, email: event.target.value }))}
                      required
                    />
                  </div>

                  <div>
                    <label style={{ display: 'block', marginBottom: 6, fontSize: 12, color: 'var(--text-muted)' }}>Password</label>
                    <input
                      className="input"
                      type="password"
                      value={createForm.password}
                      onChange={(event) => setCreateForm((current) => ({ ...current, password: event.target.value }))}
                      required
                    />
                  </div>
                </>
              )}

              <div>
                <div>
                  <label style={{ display: 'block', marginBottom: 6, fontSize: 12, color: 'var(--text-muted)' }}>Role</label>
                  <select
                    className="input"
                    value={editUser ? editForm.role : createForm.role}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (editUser) setEditForm((current) => ({ ...current, role: value }));
                      else setCreateForm((current) => ({ ...current, role: value }));
                    }}
                  >
                    {ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>{role.replace(/_/g, ' ')}</option>
                    ))}
                  </select>
                </div>
              </div>

              {editUser && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={editForm.is_active}
                    onChange={(event) => setEditForm((current) => ({ ...current, is_active: event.target.checked }))}
                  />
                  User is active
                </label>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingTop: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={`badge ${ROLE_BADGES[(editUser ? editForm.role : createForm.role)] || 'badge-neutral'}`}>
                    {(editUser ? editForm.role : createForm.role).replace(/_/g, ' ')}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {ROLE_COLOR_KEYS[editUser ? editForm.role : createForm.role].replace(/^\w/, (char) => char.toUpperCase())} role access
                  </span>
                </div>
                <button type="submit" className="btn btn-primary" disabled={submitting}>
                  {submitting ? 'Saving...' : editUser ? 'Save Changes' : 'Create User'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardLayout>
  );
}

UsersPage.getLayout = (page) => page;
