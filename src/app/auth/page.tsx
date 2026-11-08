import { AuthForm } from '@/components/auth/auth-form';
export default function AuthPage() {
  return <section className="narrow"><h1>Welcome to LocalBazaar</h1>
    <p className="muted">Sign in or create an account to manage your shop.</p><AuthForm /></section>;
}
