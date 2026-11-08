'use client';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <section className="panel"><h1>We couldn’t load this page</h1>
    <p role="alert">Please try again in a moment.</p>
    <button className="button primary" onClick={reset}>Try again</button></section>;
}
