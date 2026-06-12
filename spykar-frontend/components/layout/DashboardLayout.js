import { useEffect } from 'react';
import { useRouter } from 'next/router';
import Sidebar from './Sidebar';
import Header from './Header';
import ExceptionAlertStrip from './ExceptionAlertStrip';
import AiChatbot from '../AiChatbot';
import CommandPalette from '../ui/CommandPalette';
import { useAuth } from '../../lib/auth-context';

export default function DashboardLayout({ children, title, subtitle, allowedRoles, headerSlot, hideSync }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const isAllowed = !allowedRoles?.length || (user && allowedRoles.includes(user.role));

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [user, loading, router]);

  useEffect(() => {
    if (!loading && user && !isAllowed) router.replace('/');
  }, [user, loading, isAllowed, router]);

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg-canvas)',
        flexDirection: 'column',
        gap: 16,
      }}>
        <div style={{
          width: 40, height: 40,
          background: 'linear-gradient(135deg, #EF4444, #DC2626)',
          borderRadius: 10,
          animation: 'pulse 1.5s ease infinite',
          boxShadow: '0 0 24px rgba(239,68,68,0.40)',
        }} />
        <div style={{ color: 'var(--text-muted)', fontSize: 13, fontFamily: 'var(--font-body)' }}>Loading Spykar IQ…</div>
        <style>{`@keyframes pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:0.5; transform:scale(0.9); } }`}</style>
      </div>
    );
  }

  if (!user || !isAllowed) return null;

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main-content">
        <Header title={title} subtitle={subtitle} headerSlot={headerSlot} hideSync={hideSync} />
        {/* ExceptionAlertStrip removed — the "CRITICAL Unknown store" ribbon
            was firing on every page even when stores were missing labels in
            the data. Disabled by request. */}
        <main className="page-content">
          {children}
        </main>
      </div>
      <AiChatbot />
      <CommandPalette />
    </div>
  );
}
