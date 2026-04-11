import { useState } from 'react';
import { useRouter } from 'next/router';
import { Eye, EyeOff, Loader2, ShieldCheck } from 'lucide-react';
import { useAuth } from '../lib/auth-context';
import toast from 'react-hot-toast';

export default function LoginPage() {
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [loading, setLoading]   = useState(false);
  const { login } = useAuth();
  const router    = useRouter();

  async function handleSubmit(e) {
    e.preventDefault();
    if (!email || !password) return toast.error('Please enter email and password.');
    setLoading(true);
    try {
      await login(email, password);
      router.replace('/');
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Login failed. Check your credentials.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(150deg, #F4F6FB 0%, #FFF5F4 50%, #F4F6FB 100%)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      fontFamily: 'var(--font-body)',
    }}>

      {/* Subtle background circles — complement the white, no harsh colors */}
      <div style={{
        position: 'fixed', top: '8%', left: '8%',
        width: 320, height: 320,
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(192,57,43,0.07) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'fixed', bottom: '10%', right: '8%',
        width: 260, height: 260,
        borderRadius: '50%',
        background: 'radial-gradient(circle, rgba(13,148,136,0.06) 0%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      <div style={{ width: '100%', maxWidth: 400, position: 'relative', zIndex: 1 }}>

        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 36 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginBottom: 10 }}>
            <img
              src="/spykar-logo.png"
              alt="Spykar"
              style={{ width: 64, height: 64, objectFit: 'contain', borderRadius: 14, boxShadow: '0 4px 20px rgba(192,57,43,0.18)', display: 'block', flexShrink: 0 }}
              onError={e => e.target.style.display = 'none'}
            />
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 900, fontSize: 30, letterSpacing: '-0.04em', color: '#1E293B', lineHeight: 1 }}>
                Spykar <span style={{ color: '#C0392B' }}>IQ</span>
              </div>
              <div style={{ fontSize: 10, color: '#94A3B8', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 5 }}>
                Inventory Intelligence
              </div>
            </div>
          </div>
        </div>

        {/* Login card */}
        <div style={{
          background: '#FFFFFF',
          border: '1px solid rgba(15,23,42,0.08)',
          borderRadius: 20,
          padding: '36px 32px',
          boxShadow: '0 8px 32px rgba(15,23,42,0.08), 0 2px 8px rgba(15,23,42,0.04)',
        }}>

          <div style={{ marginBottom: 24 }}>
            <h2 style={{
              fontFamily: 'var(--font-display)',
              fontSize: 18,
              fontWeight: 700,
              color: '#1E293B',
              letterSpacing: '-0.01em',
              marginBottom: 4,
            }}>
              Sign in
            </h2>
            <p style={{ fontSize: 12, color: '#94A3B8' }}>
              Enter your credentials to continue
            </p>
          </div>

          <form onSubmit={handleSubmit}>

            {/* Email */}
            <div style={{ marginBottom: 16 }}>
              <label style={{
                display: 'block',
                fontSize: 12,
                fontWeight: 600,
                color: '#475569',
                marginBottom: 6,
                fontFamily: 'var(--font-body)',
              }}>
                Email Address
              </label>
              <input
                className="input"
                type="email"
                placeholder="you@spykar.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                autoComplete="email"
                disabled={loading}
                style={{ fontSize: 13 }}
              />
            </div>

            {/* Password */}
            <div style={{ marginBottom: 28 }}>
              <label style={{
                display: 'block',
                fontSize: 12,
                fontWeight: 600,
                color: '#475569',
                marginBottom: 6,
                fontFamily: 'var(--font-body)',
              }}>
                Password
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  className="input"
                  type={showPw ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete="current-password"
                  disabled={loading}
                  style={{ paddingRight: 44, fontSize: 13 }}
                />
                <button
                  type="button"
                  onClick={() => setShowPw(v => !v)}
                  style={{
                    position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: '#94A3B8', display: 'flex', alignItems: 'center',
                    padding: 4,
                    transition: 'color 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = '#C0392B'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = '#94A3B8'; }}
                >
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '11px 20px',
                background: loading ? '#F87171' : 'linear-gradient(135deg, #C0392B, #C0392B)',
                color: '#fff',
                border: 'none',
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 600,
                fontFamily: 'var(--font-body)',
                cursor: loading ? 'not-allowed' : 'pointer',
                boxShadow: loading ? 'none' : '0 2px 12px rgba(192,57,43,0.28)',
                transition: 'all 0.15s',
                letterSpacing: '0.01em',
              }}
              onMouseEnter={e => {
                if (!loading) {
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = '0 4px 20px rgba(192,57,43,0.36)';
                }
              }}
              onMouseLeave={e => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = loading ? 'none' : '0 2px 12px rgba(192,57,43,0.28)';
              }}
            >
              {loading
                ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Signing in…</>
                : 'Sign In'}
            </button>
          </form>

          {/* Trust indicator */}
          <div style={{
            marginTop: 20,
            paddingTop: 16,
            borderTop: '1px solid rgba(15,23,42,0.06)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            color: '#94A3B8',
            fontSize: 11,
            fontFamily: 'var(--font-body)',
          }}>
            <ShieldCheck size={12} />
            <span>Secure · Role-based access control</span>
          </div>
        </div>

        <p style={{
          textAlign: 'center',
          marginTop: 20,
          fontSize: 11,
          color: '#94A3B8',
          fontFamily: 'var(--font-body)',
          letterSpacing: '0.01em',
        }}>
          Spykar Jeans · Inventory Intelligence v1.0
        </p>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
