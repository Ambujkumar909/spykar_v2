import '../styles/globals.css';
import { AuthProvider } from '../lib/auth-context';
import { Toaster } from 'react-hot-toast';
import Head from 'next/head';

export default function App({ Component, pageProps }) {
  const getLayout = Component.getLayout ?? ((page) => page);

  return (
    <AuthProvider>
      <Head>
        <title>Spykar IQ — Inventory Intelligence</title>
      </Head>
      {getLayout(<Component {...pageProps} />)}
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 4000,
          style: {
            background: '#FFFFFF',
            color: '#0F172A',
            border: '1px solid rgba(15,23,42,0.10)',
            borderRadius: '12px',
            fontSize: '14px',
            fontFamily: "'Inter', sans-serif",
            fontWeight: '500',
            boxShadow: '0 4px 24px rgba(15,23,42,0.10)',
            padding: '12px 16px',
          },
          success: { iconTheme: { primary: '#059669', secondary: '#FFFFFF' } },
          error:   { iconTheme: { primary: '#DC2626', secondary: '#FFFFFF' } },
        }}
      />
    </AuthProvider>
  );
}
