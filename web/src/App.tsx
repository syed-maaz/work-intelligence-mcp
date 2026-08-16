import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AppShell } from './components/shell/AppShell';
import { CommandPalette } from './components/shell/CommandPalette';
import { ErrorBoundary } from './components/shell/ErrorBoundary';
import ChatPage from './pages/ChatPage';
import DashboardPage from './pages/DashboardPage';
import SetupPage from './pages/SetupPage';
import GlossaryPage from './pages/GlossaryPage';
import TopicExpertPage from './pages/TopicExpertPage';
import JiraReportPage from './pages/JiraReportPage';
import TeamsUpdatesPage from './pages/TeamsUpdatesPage';
import SearchAllPage from './pages/SearchAllPage';
import ActionItemsPage from './pages/ActionItemsPage';
import DigestPage from './pages/DigestPage';
import TopicsPage from './pages/TopicsPage';
import WeeklyReportPage from './pages/WeeklyReportPage';
import SystemHealthPage from './pages/SystemHealthPage';
import TeammatesPage from './pages/TeammatesPage';
import { PRReviewPage } from './pages/PRReviewPage';
import BugsPage from './pages/BugsPage';
import DreamPage from './pages/DreamPage';
import ModelConfigPage from './pages/ModelConfigPage';
import { CypherPage } from './pages/CypherPage';
import CypherCostPage from './pages/CypherCostPage';
import BoardPage from './pages/BoardPage';
import NotFoundPage from './pages/NotFoundPage';

export default function App() {
  return (
    <BrowserRouter>
      <AppShell>
        {/* U-8: ErrorBoundary catches render errors so one page crash doesn't blank the whole app */}
        <ErrorBoundary scope="route">
          <Routes>
            <Route path="/" element={<ChatPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/setup/models" element={<ModelConfigPage />} />
            <Route path="/glossary" element={<GlossaryPage />} />
            <Route path="/topic-expert" element={<TopicExpertPage />} />
            <Route path="/jira-report" element={<JiraReportPage />} />
            <Route path="/teams-updates" element={<TeamsUpdatesPage />} />
            <Route path="/search-all" element={<SearchAllPage />} />
            <Route path="/action-items" element={<ActionItemsPage />} />
            <Route path="/digest" element={<DigestPage />} />
            <Route path="/topics" element={<TopicsPage />} />
            <Route path="/weekly-report" element={<WeeklyReportPage />} />
            <Route path="/system-health" element={<SystemHealthPage />} />
            <Route path="/teammates" element={<TeammatesPage />} />
            <Route path="/pr-review" element={<PRReviewPage />} />
            <Route path="/bugs" element={<BugsPage />} />
            <Route path="/dream" element={<DreamPage />} />
            <Route path="/cypher" element={<CypherPage />} />
            <Route path="/cypher/cost" element={<CypherCostPage />} />
            <Route path="/board" element={<BoardPage />} />
            {/* U-7: real 404 page replaces the previous soft-redirect-to-home */}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </ErrorBoundary>
      </AppShell>
      <CommandPalette />
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: 'var(--bg-2)',
            border: '1px solid var(--border)',
            color: 'var(--fg)',
            fontFamily: 'DM Sans, sans-serif',
            fontSize: '13px',
          },
        }}
      />
    </BrowserRouter>
  );
}
