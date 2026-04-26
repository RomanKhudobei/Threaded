import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

type Note = {
  id: string;
  parentId: string | null;
  text: string;
  createdAt: string;
};

type ThreadView = {
  note: Note;
  children: Note[];
  ancestors: Note[];
  hasMoreAncestors: boolean;
  totalAncestors: number;
};

type View =
  | { kind: "root" }
  | { kind: "thread"; noteId: string };

const API_BASE = "/api";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body && typeof body.detail === "string") detail = body.detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

const api = {
  listRoots: () => http<Note[]>("/notes"),
  getThread: (id: string) => http<ThreadView>(`/notes/${id}/thread`),
  createNote: (text: string, parentId: string | null) =>
    http<Note>("/notes", {
      method: "POST",
      body: JSON.stringify({ text, parentId }),
    }),
};

function ThreadArrowIcon({ title = "Reply in thread" }: { title?: string }) {
  return (
    <svg
      className="thread-arrow"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      role="img"
      aria-label={title}
      focusable="false"
    >
      <title>{title}</title>
      <path
        d="M5 6 V11 a4 4 0 0 0 4 4 H17"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M14 12 L17 15 L14 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      role="img"
      aria-label="Expand thread"
      focusable="false"
    >
      <title>Expand thread</title>
      <path
        d="M4 14 V20 H10 M20 10 V4 H14 M4 20 L10 14 M20 4 L14 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type ThreadComposerProps = {
  parentId: string | null;
  placeholder: string;
  autoFocus?: boolean;
  onCancel?: () => void;
  onCreated: (note: Note) => void;
  onExpand?: () => void;
  showExpand?: boolean;
  variant?: "inline" | "primary";
};

function ThreadComposer({
  parentId,
  placeholder,
  autoFocus,
  onCancel,
  onCreated,
  onExpand,
  showExpand,
  variant = "inline",
}: ThreadComposerProps) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      const trimmed = text.trim();
      if (!trimmed) return;
      setSubmitting(true);
      setError(null);
      try {
        const note = await api.createNote(trimmed, parentId);
        setText("");
        onCreated(note);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save note");
      } finally {
        setSubmitting(false);
      }
    },
    [text, parentId, onCreated],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <form
      className={`composer composer-${variant}`}
      onSubmit={submit}
    >
      <textarea
        className="composer-input"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus={autoFocus}
        rows={variant === "primary" ? 3 : 2}
        disabled={submitting}
      />
      <div className="composer-row">
        {error ? <span className="composer-error">{error}</span> : <span />}
        <div className="composer-actions">
          {onCancel && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onCancel}
              disabled={submitting}
            >
              Cancel
            </button>
          )}
          {showExpand && onExpand && (
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={onExpand}
              disabled={submitting}
              title="Open this thread on its own"
            >
              <ExpandIcon />
              <span>Expand</span>
            </button>
          )}
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting || !text.trim()}
          >
            {submitting ? "Saving" : variant === "primary" ? "Add thought" : "Reply"}
          </button>
        </div>
      </div>
    </form>
  );
}

type NoteCardProps = {
  note: Note;
  onCreated: (note: Note) => void;
  onOpenThread: (noteId: string) => void;
};

function NoteCard({ note, onCreated, onOpenThread }: NoteCardProps) {
  const [replying, setReplying] = useState(false);

  return (
    <article className="note-card">
      <p className="note-text">{note.text}</p>
      <div className="note-footer">
        <time className="note-meta" dateTime={note.createdAt}>
          {formatTimestamp(note.createdAt)}
        </time>
        <button
          type="button"
          className={`thread-arrow-button${replying ? " is-active" : ""}`}
          onClick={() => setReplying((v) => !v)}
          aria-label={replying ? "Close thread input" : "Reply in thread"}
          title={replying ? "Close thread input" : "Reply in thread"}
        >
          <ThreadArrowIcon />
        </button>
      </div>
      {replying && (
        <div className="thread-input">
          <ThreadComposer
            parentId={note.id}
            placeholder="Continue the thread..."
            autoFocus
            onCancel={() => setReplying(false)}
            onCreated={(child) => {
              setReplying(false);
              onCreated(child);
            }}
            onExpand={() => onOpenThread(note.id)}
            showExpand
          />
        </div>
      )}
    </article>
  );
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function truncate(text: string, max = 80): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

type RootViewProps = {
  notes: Note[];
  loading: boolean;
  error: string | null;
  onCreated: (note: Note) => void;
  onOpenThread: (noteId: string) => void;
};

function RootView({ notes, loading, error, onCreated, onOpenThread }: RootViewProps) {
  return (
    <section className="view view-root">
      <ThreadComposer
        parentId={null}
        placeholder="What are you thinking about?"
        variant="primary"
        onCreated={onCreated}
      />
      {error && <div className="banner banner-error">{error}</div>}
      {loading && notes.length === 0 ? (
        <div className="empty">Loading thoughts…</div>
      ) : notes.length === 0 ? (
        <div className="empty">No thoughts yet. Add the first one above.</div>
      ) : (
        <ol className="note-list">
          {notes.map((note) => (
            <li key={note.id}>
              <NoteCard
                note={note}
                onCreated={onCreated}
                onOpenThread={onOpenThread}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

type ThreadViewProps = {
  thread: ThreadView | null;
  loading: boolean;
  error: string | null;
  onCreated: (note: Note) => void;
  onOpenThread: (noteId: string) => void;
  onBackToRoot: () => void;
};

function FocusedThreadView({
  thread,
  loading,
  error,
  onCreated,
  onOpenThread,
  onBackToRoot,
}: ThreadViewProps) {
  if (loading && !thread) {
    return (
      <section className="view view-thread">
        <div className="empty">Loading thread…</div>
      </section>
    );
  }

  if (!thread) {
    return (
      <section className="view view-thread">
        {error && <div className="banner banner-error">{error}</div>}
        <button type="button" className="btn btn-ghost" onClick={onBackToRoot}>
          ← Back to all thoughts
        </button>
      </section>
    );
  }

  return (
    <section className="view view-thread">
      <nav className="breadcrumb" aria-label="Thread path">
        <button
          type="button"
          className="breadcrumb-link"
          onClick={onBackToRoot}
        >
          All thoughts
        </button>
        {thread.hasMoreAncestors && (
          <>
            <span className="breadcrumb-sep" aria-hidden="true">/</span>
            <span
              className="breadcrumb-more"
              title={`${thread.totalAncestors - thread.ancestors.length} more above`}
            >
              …
            </span>
          </>
        )}
        {thread.ancestors.map((ancestor) => (
          <span key={ancestor.id} className="breadcrumb-item">
            <span className="breadcrumb-sep" aria-hidden="true">/</span>
            <button
              type="button"
              className="breadcrumb-link"
              onClick={() => onOpenThread(ancestor.id)}
              title={ancestor.text}
            >
              {truncate(ancestor.text, 48)}
            </button>
          </span>
        ))}
        <span className="breadcrumb-sep" aria-hidden="true">/</span>
        <span className="breadcrumb-current" aria-current="page">
          {truncate(thread.note.text, 48)}
        </span>
      </nav>

      {error && <div className="banner banner-error">{error}</div>}

      <article className="note-card note-card-focused">
        <p className="note-text">{thread.note.text}</p>
        <time className="note-meta" dateTime={thread.note.createdAt}>
          {formatTimestamp(thread.note.createdAt)}
        </time>
      </article>

      <div className="thread-children-header">
        <span>
          {thread.children.length === 0
            ? "No replies yet"
            : thread.children.length === 1
              ? "1 reply"
              : `${thread.children.length} replies`}
        </span>
      </div>

      <ThreadComposer
        parentId={thread.note.id}
        placeholder="Add to this thread..."
        variant="primary"
        onCreated={onCreated}
      />

      {thread.children.length > 0 && (
        <ol className="note-list note-list-children">
          {thread.children.map((child) => (
            <li key={child.id}>
              <NoteCard
                note={child}
                onCreated={onCreated}
                onOpenThread={onOpenThread}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default function App() {
  const [view, setView] = useState<View>({ kind: "root" });
  const [roots, setRoots] = useState<Note[]>([]);
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshRoots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listRoots();
      setRoots(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load notes");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshThread = useCallback(async (noteId: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getThread(noteId);
      setThread(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load thread");
      setThread(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view.kind === "root") {
      void refreshRoots();
    } else {
      void refreshThread(view.noteId);
    }
  }, [view, refreshRoots, refreshThread]);

  const handleCreated = useCallback(
    (note: Note) => {
      if (view.kind === "root" && note.parentId === null) {
        setRoots((prev) => [...prev, note]);
        return;
      }
      if (view.kind === "thread" && note.parentId === view.noteId) {
        setThread((prev) =>
          prev ? { ...prev, children: [...prev.children, note] } : prev,
        );
        return;
      }
      // Created somewhere not directly visible (e.g., grandchild). Refetch
      // current view so counters and lists stay accurate.
      if (view.kind === "root") void refreshRoots();
      else void refreshThread(view.noteId);
    },
    [view, refreshRoots, refreshThread],
  );

  const handleOpenThread = useCallback((noteId: string) => {
    setView({ kind: "thread", noteId });
  }, []);

  const handleBackToRoot = useCallback(() => {
    setView({ kind: "root" });
  }, []);

  const subtitle = useMemo(() => {
    if (view.kind === "root") return "A quiet place for threaded thinking.";
    return "Following the thread.";
  }, [view]);

  return (
    <div className="app">
      <header className="app-header">
        <button
          type="button"
          className="app-title"
          onClick={handleBackToRoot}
          aria-label="Threaded — back to all thoughts"
        >
          Threaded
        </button>
        <p className="app-subtitle">{subtitle}</p>
      </header>
      <main className="app-main">
        {view.kind === "root" ? (
          <RootView
            notes={roots}
            loading={loading}
            error={error}
            onCreated={handleCreated}
            onOpenThread={handleOpenThread}
          />
        ) : (
          <FocusedThreadView
            thread={thread}
            loading={loading}
            error={error}
            onCreated={handleCreated}
            onOpenThread={handleOpenThread}
            onBackToRoot={handleBackToRoot}
          />
        )}
      </main>
    </div>
  );
}
