import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Local Bazaar',
  description: 'Explore independent local sellers and their listings.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link className="wordmark" href="/browse">Local<span>Bazaar</span></Link>
          <nav aria-label="Main navigation">
            <Link href="/browse">Explore</Link>
            <Link href="/sell">My shop</Link>
            <Link href="/auth">Account</Link>
          </nav>
        </header>
        <main className="page-container">{children}</main>
        <footer className="site-footer">Made for people selling to people. Early development prototype.</footer>
      </body>
    </html>
  );
}
