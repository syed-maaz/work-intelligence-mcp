import React, { useEffect, useState, useMemo } from 'react';
import Layout from '@theme/Layout';

interface Ticket {
  id: string;
  title: string;
  status: 'TODO' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED';
}

interface Epic {
  id: string;
  title: string;
  status: 'TODO' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED';
  priority: string;
  agentRole: string;
  summary: string;
  dependsOn: string[];
  blocks: string[];
  docPath: string;
  tickets: Ticket[];
}

interface BacklogData {
  meta: { lastUpdated: string; project: string };
  epics: Epic[];
}

type Tab = 'overview' | 'epics' | 'tickets';

const STATUS_CONFIG = {
  DONE:        { label: 'Done',        color: '#065f46', bg: '#d1fae5', dot: '#10b981' },
  IN_PROGRESS: { label: 'In Progress', color: '#92400e', bg: '#fef3c7', dot: '#f59e0b' },
  TODO:        { label: 'To Do',       color: '#374151', bg: '#e5e7eb', dot: '#9ca3af' },
  BLOCKED:     { label: 'Blocked',     color: '#991b1b', bg: '#fee2e2', dot: '#ef4444' },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG] ?? STATUS_CONFIG.TODO;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      padding: '2px 10px', borderRadius: '9999px', fontSize: '0.78rem',
      fontWeight: 600, background: cfg.bg, color: cfg.color,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: cfg.dot, display: 'inline-block' }} />
      {cfg.label}
    </span>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const color = priority === 'High' ? '#dc2626' : priority === 'Medium' ? '#d97706' : '#6b7280';
  return (
    <span style={{ fontSize: '0.78rem', fontWeight: 600, color }}>{priority}</span>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{
      background: 'var(--ifm-card-background-color, var(--ifm-background-surface-color))',
      border: '1px solid var(--ifm-color-emphasis-200)',
      borderRadius: 12, padding: '1.5rem', textAlign: 'center',
      boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    }}>
      <div style={{ fontSize: '2.5rem', fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: '0.9rem', color: 'var(--ifm-color-emphasis-600)', marginTop: 4 }}>{label}</div>
    </div>
  );
}

export default function BacklogDashboard(): React.JSX.Element {
  const [data, setData] = useState<BacklogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [epicFilter, setEpicFilter] = useState('');

  useEffect(() => {
    fetch('/backlog-data.json')
      .then(r => r.json())
      .then(setData)
      .catch(e => setError(e.message));
  }, []);

  const allTickets = useMemo(() => {
    if (!data) return [];
    return data.epics.flatMap(epic =>
      epic.tickets.map(t => ({ ...t, epicId: epic.id, epicTitle: epic.title }))
    );
  }, [data]);

  const stats = useMemo(() => {
    if (!data) return { total: 0, done: 0, inProgress: 0, todo: 0, blocked: 0, totalTickets: 0, doneTickets: 0 };
    const epics = data.epics;
    return {
      total: epics.length,
      done: epics.filter(e => e.status === 'DONE').length,
      inProgress: epics.filter(e => e.status === 'IN_PROGRESS').length,
      todo: epics.filter(e => e.status === 'TODO').length,
      blocked: epics.filter(e => e.status === 'BLOCKED').length,
      totalTickets: allTickets.length,
      doneTickets: allTickets.filter(t => t.status === 'DONE').length,
    };
  }, [data, allTickets]);

  const filteredEpics = useMemo(() => {
    if (!data) return [];
    return data.epics.filter(e => {
      const matchSearch = !search || e.title.toLowerCase().includes(search.toLowerCase()) || e.id.toLowerCase().includes(search.toLowerCase());
      const matchStatus = !statusFilter || e.status === statusFilter;
      const matchPriority = !priorityFilter || e.priority === priorityFilter;
      return matchSearch && matchStatus && matchPriority;
    });
  }, [data, search, statusFilter, priorityFilter]);

  const filteredTickets = useMemo(() => {
    return allTickets.filter(t => {
      const matchSearch = !search || t.title.toLowerCase().includes(search.toLowerCase()) || t.id.toLowerCase().includes(search.toLowerCase());
      const matchStatus = !statusFilter || t.status === statusFilter;
      const matchEpic = !epicFilter || t.epicId === epicFilter;
      return matchSearch && matchStatus && matchEpic;
    });
  }, [allTickets, search, statusFilter, epicFilter]);

  if (error) return (
    <Layout title="Backlog Dashboard">
      <div className="container margin-vert--lg">
        <div className="alert alert--danger">Failed to load backlog data: {error}</div>
      </div>
    </Layout>
  );

  if (!data) return (
    <Layout title="Backlog Dashboard">
      <div className="container margin-vert--lg"><p>Loading...</p></div>
    </Layout>
  );

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: '8px 20px', border: 'none', cursor: 'pointer', fontSize: '0.95rem',
    fontWeight: tab === t ? 700 : 400, borderBottom: tab === t ? '3px solid var(--ifm-color-primary)' : '3px solid transparent',
    background: 'transparent', color: tab === t ? 'var(--ifm-color-primary)' : 'var(--ifm-color-emphasis-700)',
  });

  const progressPct = stats.totalTickets > 0 ? Math.round((stats.doneTickets / stats.totalTickets) * 100) : 0;

  return (
    <Layout title="Backlog Dashboard" description="Work Intelligence MCP — Epic and Ticket Backlog">
      <div className="container margin-vert--lg">

        {/* Header */}
        <div style={{ marginBottom: '2rem', borderBottom: '2px solid var(--ifm-color-primary)', paddingBottom: '1rem' }}>
          <h1 style={{ marginBottom: '0.25rem' }}>Backlog Dashboard</h1>
          <p style={{ color: 'var(--ifm-color-emphasis-600)', margin: 0 }}>
            {data.meta.project} · Last updated: {data.meta.lastUpdated}
          </p>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--ifm-color-emphasis-200)', marginBottom: '2rem' }}>
          <button style={tabStyle('overview')} onClick={() => setTab('overview')}>Overview</button>
          <button style={tabStyle('epics')} onClick={() => setTab('epics')}>Epics ({data.epics.length})</button>
          <button style={tabStyle('tickets')} onClick={() => setTab('tickets')}>Tickets ({allTickets.length})</button>
        </div>

        {/* Search + Filters (shared across Epics + Tickets tabs) */}
        {tab !== 'overview' && (
          <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
            <input
              type="text" placeholder="Search..." value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ flex: 1, minWidth: 200, padding: '0.45rem 0.75rem', borderRadius: 6, border: '1px solid var(--ifm-color-emphasis-300)', fontSize: '0.9rem' }}
            />
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              style={{ padding: '0.45rem 0.75rem', borderRadius: 6, border: '1px solid var(--ifm-color-emphasis-300)' }}>
              <option value="">All Statuses</option>
              <option value="TODO">To Do</option>
              <option value="IN_PROGRESS">In Progress</option>
              <option value="DONE">Done</option>
              <option value="BLOCKED">Blocked</option>
            </select>
            {tab === 'epics' && (
              <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)}
                style={{ padding: '0.45rem 0.75rem', borderRadius: 6, border: '1px solid var(--ifm-color-emphasis-300)' }}>
                <option value="">All Priorities</option>
                <option value="High">High</option>
                <option value="Medium">Medium</option>
                <option value="Low">Low</option>
              </select>
            )}
            {tab === 'tickets' && (
              <select value={epicFilter} onChange={e => setEpicFilter(e.target.value)}
                style={{ padding: '0.45rem 0.75rem', borderRadius: 6, border: '1px solid var(--ifm-color-emphasis-300)' }}>
                <option value="">All Epics</option>
                {data.epics.map(e => <option key={e.id} value={e.id}>{e.id}: {e.title}</option>)}
              </select>
            )}
          </div>
        )}

        {/* ── OVERVIEW TAB ── */}
        {tab === 'overview' && (
          <div>
            <div className="row" style={{ marginBottom: '2rem' }}>
              <div className="col col--2"><StatCard label="Total Epics" value={stats.total} color="var(--ifm-color-primary)" /></div>
              <div className="col col--2"><StatCard label="Done" value={stats.done} color="#10b981" /></div>
              <div className="col col--2"><StatCard label="In Progress" value={stats.inProgress} color="#f59e0b" /></div>
              <div className="col col--2"><StatCard label="To Do" value={stats.todo} color="#9ca3af" /></div>
              <div className="col col--2"><StatCard label="Blocked" value={stats.blocked} color="#ef4444" /></div>
              <div className="col col--2"><StatCard label="Tickets Done" value={stats.doneTickets} color="#6366f1" /></div>
            </div>

            {/* Progress bar */}
            <div style={{ marginBottom: '2rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontWeight: 600 }}>Overall Progress</span>
                <span style={{ color: 'var(--ifm-color-emphasis-600)' }}>{stats.doneTickets} / {stats.totalTickets} tickets ({progressPct}%)</span>
              </div>
              <div style={{ height: 10, borderRadius: 9999, background: 'var(--ifm-color-emphasis-200)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${progressPct}%`, background: 'var(--ifm-color-primary)', borderRadius: 9999, transition: 'width 0.4s' }} />
              </div>
            </div>

            {/* Epic cards */}
            <h2>All Epics</h2>
            <div className="row">
              {data.epics.map(epic => {
                const doneCount = epic.tickets.filter(t => t.status === 'DONE').length;
                const pct = epic.tickets.length > 0 ? Math.round((doneCount / epic.tickets.length) * 100) : 0;
                return (
                  <div className="col col--4" key={epic.id} style={{ marginBottom: '1rem' }}>
                    <div style={{
                      border: '1px solid var(--ifm-color-emphasis-200)', borderRadius: 10, padding: '1.25rem',
                      height: '100%', display: 'flex', flexDirection: 'column', gap: '0.75rem',
                      background: 'var(--ifm-card-background-color, var(--ifm-background-surface-color))',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <span style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--ifm-color-emphasis-600)' }}>{epic.id}</span>
                        <StatusBadge status={epic.status} />
                      </div>
                      <a href={epic.docPath} style={{ fontWeight: 700, fontSize: '1rem', textDecoration: 'none' }}>{epic.title}</a>
                      <p style={{ fontSize: '0.85rem', color: 'var(--ifm-color-emphasis-700)', margin: 0, flex: 1 }}>{epic.summary}</p>
                      <div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--ifm-color-emphasis-600)', marginBottom: 4 }}>{doneCount}/{epic.tickets.length} tickets · <PriorityBadge priority={epic.priority} /></div>
                        <div style={{ height: 5, borderRadius: 9999, background: 'var(--ifm-color-emphasis-200)', overflow: 'hidden' }}>
                          <div style={{ height: '100%', width: `${pct}%`, background: pct === 100 ? '#10b981' : 'var(--ifm-color-primary)', borderRadius: 9999 }} />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── EPICS TAB ── */}
        {tab === 'epics' && (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--ifm-color-emphasis-200)' }}>
                {['Epic', 'Title', 'Status', 'Priority', 'Agent Role', 'Tickets', 'Depends On', ''].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredEpics.map(epic => {
                const doneCount = epic.tickets.filter(t => t.status === 'DONE').length;
                return (
                  <tr key={epic.id} style={{ borderBottom: '1px solid var(--ifm-color-emphasis-100)' }}>
                    <td style={{ padding: '10px 12px', fontWeight: 700, fontSize: '0.85rem', whiteSpace: 'nowrap' }}>{epic.id}</td>
                    <td style={{ padding: '10px 12px', maxWidth: 260 }}>
                      <a href={epic.docPath} style={{ fontWeight: 600 }}>{epic.title}</a>
                      <div style={{ fontSize: '0.78rem', color: 'var(--ifm-color-emphasis-600)', marginTop: 2 }}>{epic.summary.slice(0, 80)}…</div>
                    </td>
                    <td style={{ padding: '10px 12px' }}><StatusBadge status={epic.status} /></td>
                    <td style={{ padding: '10px 12px' }}><PriorityBadge priority={epic.priority} /></td>
                    <td style={{ padding: '10px 12px', fontSize: '0.82rem', color: 'var(--ifm-color-emphasis-700)' }}>{epic.agentRole}</td>
                    <td style={{ padding: '10px 12px', fontSize: '0.85rem', whiteSpace: 'nowrap' }}>{doneCount}/{epic.tickets.length}</td>
                    <td style={{ padding: '10px 12px', fontSize: '0.82rem' }}>
                      {epic.dependsOn.map(d => <span key={d} style={{ marginRight: 4, padding: '1px 6px', background: 'var(--ifm-color-emphasis-100)', borderRadius: 4 }}>{d}</span>)}
                      {epic.dependsOn.length === 0 && <span style={{ color: 'var(--ifm-color-emphasis-400)' }}>—</span>}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <a href={epic.docPath} className="button button--sm button--primary">View Epic →</a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {/* ── TICKETS TAB ── */}
        {tab === 'tickets' && (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid var(--ifm-color-emphasis-200)' }}>
                {['Ticket', 'Title', 'Epic', 'Status'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: '0.82rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredTickets.map(ticket => (
                <tr key={ticket.id} style={{ borderBottom: '1px solid var(--ifm-color-emphasis-100)' }}>
                  <td style={{ padding: '10px 12px', fontWeight: 700, fontSize: '0.82rem', whiteSpace: 'nowrap', color: 'var(--ifm-color-emphasis-600)' }}>{ticket.id}</td>
                  <td style={{ padding: '10px 12px' }}>{ticket.title}</td>
                  <td style={{ padding: '10px 12px', fontSize: '0.82rem' }}>
                    <a href={data.epics.find(e => e.id === ticket.epicId)?.docPath ?? '#'}>{ticket.epicId}: {ticket.epicTitle}</a>
                  </td>
                  <td style={{ padding: '10px 12px' }}><StatusBadge status={ticket.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      </div>
    </Layout>
  );
}
