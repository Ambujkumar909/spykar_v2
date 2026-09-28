import { useEffect } from 'react';
import { useRouter } from 'next/router';
export default function MovementsRedirect() {
  const router = useRouter();
  // /dispatch never existed (a 404). Sales & returns live on /sales.
  useEffect(() => { router.replace('/sales'); }, [router]);
  return null;
}
