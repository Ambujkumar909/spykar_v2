import { useEffect } from 'react';
import { useRouter } from 'next/router';
import Sidebar from './Sidebar';
import Header from './Header';
import AiChatbot from '../AiChatbot';
import CommandPalette from '../ui/CommandPalette';
import { useAuth } from '../../lib/auth-context';

export default function DashboardLayout({ children, title, subtitle, allowedRoles }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const isAllowed = !allowedRoles?.length || (user && allowedRoles.includes(user.role));

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
    }
  }, [user, loading, router]);

  useEffect(() => {
    if (!loading && user && !isAllowed) {
      router.replace('/');
    }
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
          background: 'linear-gradient(135deg, var(--accent-primary), #0066ff)',
          borderRadius: 10,
          animation: 'pulse 1.5s ease infinite',
        }} />
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading Spykar IQ…</div>
        <style>{`
          @keyframes pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:0.5; transform:scale(0.9); } }
        `}</style>
      </div>
    );
  }

  if (!user || !isAllowed) return null;

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="main-content">
        <Header title={title} subtitle={subtitle} />
        <main className="page-content">
          {children}
        </main>
      </div>
      <AiChatbot />
      {/* ⌘K command palette — elite-tier keyboard-first navigation, available
          on every page. The single biggest UX leap over Power BI/Zoho/Tableau
          and matches the bar set by Linear / Stripe / Notion / Vercel. */}
      <CommandPalette />
    </div>
  );
}
