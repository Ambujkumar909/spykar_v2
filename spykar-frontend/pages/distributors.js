import { useEffect } from 'react';
import { useRouter } from 'next/router';
export default function DistributorsRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace('/network'); }, [router]);
  return null;
}
