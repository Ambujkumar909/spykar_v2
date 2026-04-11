import { useEffect } from 'react';
import { useRouter } from 'next/router';
export default function LocationsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/network'); }, [router]);
  return null;
}
