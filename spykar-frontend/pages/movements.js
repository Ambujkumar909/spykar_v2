import { useEffect } from 'react';
import { useRouter } from 'next/router';
export default function MovementsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/dispatch'); }, [router]);
  return null;
}
