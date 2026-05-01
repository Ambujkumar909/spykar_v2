import '../styles/globals.css';
import { AuthProvider } from '../lib/auth-context';
import { Toaster } from 'react-hot-toast';
import Head from 'next/head';
import { useTheme } from '../lib/useTheme';

// Pre-hydration theme bootstrap — runs in <head> BEFORE React hydrates so
// the page paints in the user's chosen mode without a dark→light flash.
// Reads the same localStorage key (`spykar-theme`) as lib/useTheme.
const THEME_BOOTSTRAP = `
(function () {
  try {
    var t = localStorage.getItem('spykar-theme');
    if (t !== 'light' && t !== 'dark') {
      t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    }
    if (t === 'light') document.documentElement.classList.add('theme-light');
  } catch (_) {}
})();
`;

export default function App({ Component, pageProps }) {
  const getLayout = Component.getLayout ?? ((page) => page);
  // Subscribe so React state stays in sync with the class on <html>.
  // The pre-hydration script already painted the right mode; this hook
  // is what makes the toggle actually work post-mount.
  const { isDark } = useTheme();

  // Theme-aware toast colors so notifications read correctly in both modes.
  const toastBg     = isDark ? '#111827' : '#FFFFFF';
  const toastColor  = isDark ? '#F1F5F9' : '#0F172A';
  const toastBorder = isDark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)';
  const toastShadow = isDark
    ? '0 4px 24px rgba(0,0,0,0.50)'
    : '0 4px 24px rgba(15,23,42,0.10)';

  return (
    <AuthProvider>
      <Head>
        <title>Spykar IQ — Inventory Intelligence</title>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </Head>
      {getLayout(<Component {...pageProps} />)}
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 4000,
          style: {
            background: toastBg,
            color: toastColor,
            border: `1px solid ${toastBorder}`,
            borderRadius: '12px',
            fontSize: '14px',
            fontFamily: "'Inter', sans-serif",
            fontWeight: '500',
            boxShadow: toastShadow,
            padding: '12px 16px',
          },
          success: { iconTheme: { primary: '#059669', secondary: toastBg } },
          error:   { iconTheme: { primary: '#DC2626', secondary: toastBg } },
        }}
      />
    </AuthProvider>
  );
}
