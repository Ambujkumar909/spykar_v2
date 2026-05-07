import { useState } from 'react';
import { useRouter } from 'next/router';
import {
  ArrowRight,
  Eye,
  EyeOff,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../lib/auth-context';
import toast from 'react-hot-toast';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const router = useRouter();

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
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background:
          'radial-gradient(circle at top left, rgba(185,28,28,0.10) 0%, transparent 28%), radial-gradient(circle at bottom right, rgba(30,64,175,0.08) 0%, transparent 26%), linear-gradient(145deg, #f7f5f2 0%, #f2f5fa 52%, #edf1f7 100%)',
        position: 'relative',
        overflow: 'hidden',
        fontFamily: 'var(--font-body)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            'linear-gradient(rgba(15,23,42,0.028) 1px, transparent 1px), linear-gradient(90deg, rgba(15,23,42,0.028) 1px, transparent 1px)',
          backgroundSize: '54px 54px',
          pointerEvents: 'none',
        }}
      />

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          maxWidth: 430,
          padding: 14,
          borderRadius: 18,
          background: 'rgba(255,255,255,0.42)',
          border: '1px solid rgba(255,255,255,0.58)',
          boxShadow: '0 32px 80px rgba(15,23,42,0.14)',
          backdropFilter: 'blur(22px)',
          WebkitBackdropFilter: 'blur(22px)',
        }}
      >
        <div
          style={{
            borderRadius: 10,
            background: 'linear-gradient(180deg, rgba(255,255,255,0.97), rgba(248,250,252,0.95))',
            border: '1px solid rgba(15,23,42,0.08)',
            padding: '34px 30px 26px',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.95)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <div
              style={{
                width: 62,
                height: 62,
                borderRadius: 14,
                background: 'linear-gradient(135deg, rgba(225,29,46,0.16), rgba(225,29,46,0.05))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.88), 0 14px 28px rgba(225,29,46,0.10)',
              }}
            >
              <img
                src="/spykar-logo.png"
                alt="Spykar"
                style={{ width: 40, height: 40, objectFit: 'contain' }}
                onError={e => { e.currentTarget.style.display = 'none'; }}
              />
            </div>
          </div>

          <div style={{ marginTop: 22, textAlign: 'center' }}>
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 32,
                fontWeight: 900,
                letterSpacing: '-0.04em',
                color: '#0f172a',
                lineHeight: 1,
              }}
            >
              Spykar <span style={{ color: '#b91c1c' }}>IQ</span>
            </div>

            <div
              style={{
                marginTop: 10,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '6px 10px',
                borderRadius: 999,
                border: '1px solid rgba(15,23,42,0.08)',
                background: 'rgba(255,255,255,0.8)',
                color: '#6b7280',
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
              }}
            >
              <ShieldCheck size={12} />
              Secure Access
            </div>

            <h1
              style={{
                marginTop: 22,
                fontFamily: "'Source Serif 4', Georgia, serif",
                fontSize: 34,
                fontWeight: 560,
                lineHeight: 1.06,
                letterSpacing: 0,
                color: '#111827',
              }}
            >
              Sign in
            </h1>

            <p
              style={{
                marginTop: 10,
                fontSize: 13,
                lineHeight: 1.7,
                color: '#667085',
              }}
            >
              Inventory intelligence dashboard
            </p>
          </div>

          <form onSubmit={handleSubmit} style={{ marginTop: 28 }}>
            <div style={{ display: 'grid', gap: 16 }}>
              <div>
                <label
                  style={{
                    display: 'block',
                    marginBottom: 8,
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: '#6b7280',
                  }}
                >
                  Email
                </label>
                <input
                  className="input"
                  type="email"
                  placeholder="you@spykar.com"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  autoComplete="email"
                  disabled={loading}
                  style={{
                    height: 54,
                    padding: '0 15px',
                    fontSize: 14,
                    background: 'rgba(255,255,255,0.92)',
                    borderColor: 'rgba(15,23,42,0.10)',
                    color: '#0f172a',
                    borderRadius: 10,
                    boxShadow: 'inset 0 1px 2px rgba(15,23,42,0.03)',
                  }}
                />
              </div>

              <div>
                <label
                  style={{
                    display: 'block',
                    marginBottom: 8,
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: '#6b7280',
                  }}
                >
                  Password
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    className="input"
                    type={showPw ? 'text' : 'password'}
                    placeholder="Enter your password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    autoComplete="current-password"
                    disabled={loading}
                    style={{
                      height: 54,
                      padding: '0 48px 0 15px',
                      fontSize: 14,
                      background: 'rgba(255,255,255,0.92)',
                      borderColor: 'rgba(15,23,42,0.10)',
                      color: '#0f172a',
                      borderRadius: 10,
                      boxShadow: 'inset 0 1px 2px rgba(15,23,42,0.03)',
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(v => !v)}
                    disabled={loading}
                    style={{
                      position: 'absolute',
                      top: '50%',
                      right: 10,
                      transform: 'translateY(-50%)',
                      width: 32,
                      height: 32,
                      border: 'none',
                      borderRadius: 8,
                      background: 'transparent',
                      color: '#98a2b3',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: loading ? 'default' : 'pointer',
                      transition: 'all 160ms ease',
                    }}
                    onMouseEnter={e => {
                      if (!loading) {
                        e.currentTarget.style.color = '#b91c1c';
                        e.currentTarget.style.background = 'rgba(185,28,28,0.08)';
                      }
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.color = '#98a2b3';
                      e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    {showPw ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                height: 54,
                marginTop: 22,
                border: 'none',
                borderRadius: 10,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                background: loading
                  ? 'linear-gradient(135deg, #ef4444, #dc2626)'
                  : 'linear-gradient(135deg, #e11d2e 0%, #a61b28 52%, #5b1220 100%)',
                color: '#ffffff',
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: '0.01em',
                cursor: loading ? 'not-allowed' : 'pointer',
                boxShadow: loading
                  ? '0 10px 22px rgba(225,29,46,0.14)'
                  : '0 18px 34px rgba(166,27,40,0.24)',
                transition: 'transform 180ms ease, box-shadow 180ms ease, filter 180ms ease',
              }}
              onMouseEnter={e => {
                if (!loading) {
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = '0 22px 40px rgba(166,27,40,0.28)';
                }
              }}
              onMouseLeave={e => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = loading
                  ? '0 10px 22px rgba(225,29,46,0.14)'
                  : '0 18px 34px rgba(166,27,40,0.24)';
              }}
            >
              {loading ? (
                <>
                  <Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />
                  Signing in...
                </>
              ) : (
                <>
                  Continue
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>
        </div>
      </div>

      <style>{`
        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
}
