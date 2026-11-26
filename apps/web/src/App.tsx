import { useEffect, useState } from 'react';
import { DocumentDetail } from './components/DocumentDetail.js';
import { DocumentList } from './components/DocumentList.js';

export type Route = { page: 'list' } | { page: 'detail'; id: string; version?: number };

export function parseRoute(hash: string): Route {
  const m = /^#?\/documents\/([^/]+)(?:\/v\/(\d+))?\/?$/.exec(hash);
  if (m) return { page: 'detail', id: decodeURIComponent(m[1]!), version: m[2] ? Number(m[2]) : undefined };
  return { page: 'list' };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const go = (path: string) => {
    window.location.hash = path;
  };

  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">
          Lomi <span>review</span>
        </a>
        <span className="muted small">Every extracted value is checked against its source passage before it is trusted.</span>
      </header>
      {route.page === 'list' ? (
        <DocumentList open={(id) => go(`/documents/${id}`)} />
      ) : (
        <DocumentDetail key={`${route.id}:${route.version ?? 'current'}`} id={route.id} version={route.version} go={go} />
      )}
    </>
  );
}
