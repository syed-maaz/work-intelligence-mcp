/**
 * U-6 — Chat as the primary surface (homepage).
 */
import { ChatPanel } from '@/components/shell/ChatPanel';

export default function ChatPage() {
  return (
    <div className="h-[calc(100vh-7rem)] -mx-3 -my-4 sm:-mx-4 sm:-my-5 md:-m-6 flex flex-col min-h-0">
      <ChatPanel fullPage />
    </div>
  );
}
