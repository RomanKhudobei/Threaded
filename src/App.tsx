import {
  FormEvent,
  KeyboardEvent,
  ReactNode,
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Note = {
  id: string;
  parentId: string | null;
  text: string;
  createdAt: string;
  childCount: number;
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
const THREAD_ROUTE_PREFIX = "/thread/";

function viewFromPath(pathname: string): View {
  if (pathname.startsWith(THREAD_ROUTE_PREFIX)) {
    const encodedId = pathname.slice(THREAD_ROUTE_PREFIX.length);
    if (encodedId) {
      return { kind: "thread", noteId: decodeURIComponent(encodedId) };
    }
  }
  return { kind: "root" };
}

function pathFromView(view: View): string {
  if (view.kind === "thread") {
    return `${THREAD_ROUTE_PREFIX}${encodeURIComponent(view.noteId)}`;
  }
  return "/";
}

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

// ——— time helpers ———
function fmtTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today · ${time}`;
  if (isYesterday) return `Yest · ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} · ${time}`;
}

function relTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function truncate(text: string, max = 80): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function extractTags(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/#(\w+)/g)) out.push(m[1]);
  return out;
}

// ——— icons ———
const iconProps = {
  viewBox: "0 0 16 16",
  width: 14,
  height: 14,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const Icons = {
  Reply: () => (
    <svg {...iconProps} aria-hidden="true">
      <path d="M8 3 4 7l4 4" />
      <path d="M4 7h6a3 3 0 0 1 3 3v3" />
    </svg>
  ),
  Search: () => (
    <svg {...iconProps} aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="m13 13-2.8-2.8" />
    </svg>
  ),
  Plus: () => (
    <svg {...iconProps} aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  ),
  Sun: () => (
    <svg {...iconProps} aria-hidden="true">
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
    </svg>
  ),
  Moon: () => (
    <svg {...iconProps} aria-hidden="true">
      <path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z" />
    </svg>
  ),
  Chevron: () => (
    <svg {...iconProps} width={12} height={12} aria-hidden="true">
      <path d="m6 4 4 4-4 4" />
    </svg>
  ),
  X: () => (
    <svg {...iconProps} width={12} height={12} aria-hidden="true">
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  ),
};

// ——— wordmark / brand ———
function Wordmark({ size = "lg" }: { size?: "sm" | "lg" }) {
  return (
    <span className={`wordmark wordmark--${size}`}>
      <span className="brand-mark" aria-hidden="true">
        <span className="brand-line" />
        <span className="brand-line" />
        <span className="brand-line" />
      </span>
      <span className="wordmark-text">Threaded</span>
    </span>
  );
}

// ——— rotating tagline (sidebar foot) ———
const TAGLINES = [
  "The best way to save your thoughts — write them down.",
  "Your ideas are precious.",
  "A quiet mind makes loud thoughts.",
  "Today's note is tomorrow's archive.",
  "Your ideas worth noting.",
];

function RotatingTagline() {
  const [idx, setIdx] = useState(() =>
    Math.floor(Math.random() * TAGLINES.length),
  );
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const id = window.setInterval(() => {
      setShown(false);
      window.setTimeout(() => {
        setIdx((i) => (i + 1) % TAGLINES.length);
        setShown(true);
      }, 320);
    }, 5 * 60 * 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className={`tagline ${shown ? "is-in" : "is-out"}`}>
      {TAGLINES[idx]}
    </div>
  );
}

// ——— composer ———
type ComposerProps = {
  parentId: string | null;
  placeholder: string;
  ctaLabel?: string;
  variant?: "primary" | "inline";
  autoFocus?: boolean;
  onCancel?: () => void;
  onCreated: (note: Note) => void;
};

function Composer({
  parentId,
  placeholder,
  ctaLabel = "Add thought",
  variant = "primary",
  autoFocus,
  onCancel,
  onCreated,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "Escape" && onCancel) {
      e.preventDefault();
      onCancel();
    }
  };

  const compact = variant === "inline";

  return (
    <form className={`composer ${compact ? "is-compact" : ""}`} onSubmit={submit}>
      <textarea
        ref={ref}
        className="composer-input"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={compact ? 2 : 4}
        disabled={submitting}
      />
      <div className="composer-row">
        {error ? (
          <span className="composer-error">{error}</span>
        ) : !compact ? (
          <span className="composer-hint">
            <kbd>⌘</kbd>
            <kbd>↵</kbd>
            <span className="composer-hint-text">to post</span>
          </span>
        ) : (
          <span className="composer-hint" aria-hidden="true" />
        )}
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
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting || !text.trim()}
          >
            {submitting ? "Saving…" : ctaLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

// ——— thought card ———
type ThoughtCardProps = {
  note: Note;
  onOpenThread: (noteId: string) => void;
  onCreated: (note: Note) => void;
  activeReplyComposerId: string | null;
  onReplyComposerChange: (noteId: string | null) => void;
  isFocused?: boolean;
};

function ThoughtCard({
  note,
  onOpenThread,
  onCreated,
  activeReplyComposerId,
  onReplyComposerChange,
  isFocused,
}: ThoughtCardProps) {
  const replying = activeReplyComposerId === note.id;
  const tags = useMemo(() => extractTags(note.text), [note.text]);
  const displayText = useMemo(
    () => note.text.replace(/#(\w+)/g, "").replace(/\s+\n/g, "\n").trim() || note.text,
    [note.text],
  );
  const replies = note.childCount;
  return (
    <div className={`thought ${isFocused ? "is-focused" : ""}`}>
      <article className="thought-card">
        <p className="thought-body">{displayText}</p>
        <div className="thought-meta">
          <time className="ts" dateTime={note.createdAt}>
            {fmtTimestamp(note.createdAt)}
          </time>
          {tags.length > 0 && (
            <span className="tags">
              {tags.map((t) => (
                <span key={t} className="tag">
                  #{t}
                </span>
              ))}
            </span>
          )}
          <span className="thought-spacer" />
          {replies > 0 && (
            <button
              type="button"
              className="meta-btn"
              onClick={() => onOpenThread(note.id)}
              title="Open thread"
            >
              {replies} {replies === 1 ? "reply" : "replies"}
              <Icons.Chevron />
            </button>
          )}
          <button
            type="button"
            className={`meta-btn ${replying ? "is-active" : ""}`}
            onClick={() => onReplyComposerChange(replying ? null : note.id)}
            aria-label={replying ? "Close reply" : "Reply in thread"}
            title={replying ? "Close reply" : "Reply in thread"}
          >
            <Icons.Reply />
          </button>
        </div>
      </article>
      {replying && (
        <div className="thought-reply">
          <Composer
            parentId={note.id}
            placeholder="Continue the thread…"
            ctaLabel="Reply"
            variant="inline"
            autoFocus
            onCancel={() => onReplyComposerChange(null)}
            onCreated={(child) => {
              onReplyComposerChange(null);
              onCreated(child);
            }}
          />
        </div>
      )}
    </div>
  );
}

// ——— sidebar ———
type SidebarProps = {
  roots: Note[];
  currentRootId: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  activeTag: string | null;
  onTagClick: (tag: string) => void;
  tags: { name: string; count: number }[];
  onSelect: (id: string) => void;
  onNew: () => void;
};

function Sidebar({
  roots,
  currentRootId,
  query,
  onQueryChange,
  activeTag,
  onTagClick,
  tags,
  onSelect,
  onNew
}: SidebarProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const list = listRef.current;
    if (!wrap || !list) return;
    const update = () => {
      const top = list.scrollTop > 2;
      const bot = list.scrollTop + list.clientHeight < list.scrollHeight - 2;
      wrap.dataset.shadowTop = top ? "1" : "0";
      wrap.dataset.shadowBot = bot ? "1" : "0";
    };
    update();
    list.addEventListener("scroll", update);
    const ro = new ResizeObserver(update);
    ro.observe(list);
    return () => {
      list.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [roots.length]);

  return (
    <aside className="sidebar" ref={wrapRef}>
      <div className="sidebar-brand">
        <Wordmark size="sm" />
      </div>

      <button type="button" className="sidebar-new" onClick={onNew}>
        <Icons.Plus /> New thought
        <span className="kbd-hint">
          <kbd>⌘</kbd>
          <kbd>K</kbd>
        </span>
      </button>

      <div className="sidebar-search">
        <Icons.Search />
        <input
          placeholder="Search thoughts"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
        />
        {query && (
          <button
            type="button"
            className="search-clear"
            onClick={() => onQueryChange("")}
            aria-label="Clear search"
          >
            <Icons.X />
          </button>
        )}
      </div>

      {tags.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-label">Tags</div>
          <div className="sidebar-tags">
            {tags.map((t) => (
              <button
                key={t.name}
                type="button"
                className={`chip ${activeTag === t.name ? "is-active" : ""}`}
                onClick={() => onTagClick(t.name)}
              >
                #{t.name}
                <span className="chip-count">{t.count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="sidebar-section sidebar-section--grow">
        <div className="sidebar-label">
          All threads <span className="muted">{roots.length}</span>
        </div>
        <div className="sidebar-list-wrap">
          <div className="sidebar-list" ref={listRef}>
            {roots.length === 0 ? (
              <div className="muted small sidebar-empty">No thoughts yet.</div>
            ) : (
              roots.map((r) => {
                const isActive = currentRootId === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={`thread-item ${isActive ? "is-active" : ""}`}
                    onClick={() => onSelect(r.id)}
                  >
                    {isActive && (
                      <span className="thread-item-bar" aria-hidden="true" />
                    )}
                    <div className="thread-item-preview">
                      {truncate(r.text, 80)}
                    </div>
                    <div className="thread-item-meta">
                      <span className="ts">{relTimestamp(r.createdAt)}</span>
                      {r.childCount > 0 && (
                        <span className="muted">
                          · {r.childCount}{" "}
                          {r.childCount === 1 ? "reply" : "replies"}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
          <div
            className="scroll-shadow scroll-shadow--top"
            aria-hidden="true"
          />
          <div
            className="scroll-shadow scroll-shadow--bottom"
            aria-hidden="true"
          />
        </div>
      </div>

      <div className="sidebar-foot muted small">
        <RotatingTagline />
      </div>
    </aside>
  );
}

// ——— empty state ———
function EmptyState({
  query,
  activeTag,
}: {
  query: string;
  activeTag: string | null;
}) {
  if (query || activeTag) {
    return (
      <div className="empty">
        <div className="empty-mark">
          <span />
          <span />
          <span />
        </div>
        <div className="empty-title">No thoughts match.</div>
        <div className="empty-body">
          Try a different search, or clear the filter.
        </div>
      </div>
    );
  }
  return (
    <div className="empty">
      <div className="empty-mark">
        <span />
        <span />
        <span />
      </div>
      <div className="empty-title">A blank room.</div>
      <div className="empty-body">
        The best way to save your thoughts — write them down.
      </div>
    </div>
  );
}

// ——— root view (feed) ———
type RootViewProps = {
  roots: Note[];
  loading: boolean;
  error: string | null;
  query: string;
  activeTag: string | null;
  onCreated: (note: Note) => void;
  onOpenThread: (id: string) => void;
  activeReplyComposerId: string | null;
  onReplyComposerChange: (noteId: string | null) => void;
};

function RootView({
  roots,
  loading,
  error,
  query,
  activeTag,
  onCreated,
  onOpenThread,
  activeReplyComposerId,
  onReplyComposerChange,
}: RootViewProps) {
  return (
    <>
      <section className="hero">
        <Wordmark />
        <p className="hero-sub">A quiet place to go deep.</p>
      </section>

      <section className="composer-wrap">
        <Composer
          parentId={null}
          placeholder="What's on your mind?"
          ctaLabel="Add thought"
          onCreated={onCreated}
        />
      </section>

      {error && <div className="banner banner-error">{error}</div>}

      {loading && roots.length === 0 ? (
        <div className="loading">Loading thoughts…</div>
      ) : roots.length === 0 ? (
        <EmptyState query={query} activeTag={activeTag} />
      ) : (
        <section className="feed">
          {roots.map((root) => (
            <article key={root.id} className="feed-item">
              <ThoughtCard
                note={root}
                onOpenThread={onOpenThread}
                onCreated={onCreated}
                activeReplyComposerId={activeReplyComposerId}
                onReplyComposerChange={onReplyComposerChange}
              />
            </article>
          ))}
        </section>
      )}
    </>
  );
}

// ——— thread view ———
type ThreadPageProps = {
  thread: ThreadView | null;
  loading: boolean;
  error: string | null;
  onCreated: (note: Note) => void;
  onOpenThread: (id: string) => void;
  activeReplyComposerId: string | null;
  onReplyComposerChange: (noteId: string | null) => void;
};

function ThreadPage({
  thread,
  loading,
  error,
  onCreated,
  onOpenThread,
  activeReplyComposerId,
  onReplyComposerChange,
}: ThreadPageProps) {
  if (loading && !thread) {
    return <div className="loading">Loading thread…</div>;
  }
  if (!thread) {
    return error ? <div className="banner banner-error">{error}</div> : null;
  }

  const { note, children } = thread;
  return (
    <section className="thread-view thread-style-indent">
      <div className="thread-view-header">
        <div className="muted small">Following the thread.</div>
        <div className="thread-stats">
          {children.length} {children.length === 1 ? "reply" : "replies"}
        </div>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      <div className="node depth-0">
        <div className="node-content">
          <ThoughtCard
            note={note}
            onOpenThread={onOpenThread}
            onCreated={onCreated}
            activeReplyComposerId={activeReplyComposerId}
            onReplyComposerChange={onReplyComposerChange}
            isFocused
          />
          {children.length > 0 && (
            <div className="node__children">
              {children.map((child) => (
                <div key={child.id} className="node depth-1">
                  <div className="node-content">
                    <ThoughtCard
                      note={child}
                      onOpenThread={onOpenThread}
                      onCreated={onCreated}
                      activeReplyComposerId={activeReplyComposerId}
                      onReplyComposerChange={onReplyComposerChange}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ——— breadcrumb (topbar) ———
function Breadcrumb({
  view,
  thread,
  query,
  activeTag,
  onClearFilters,
  onBack,
  onOpenThread,
}: {
  view: View;
  thread: ThreadView | null;
  query: string;
  activeTag: string | null;
  onClearFilters: () => void;
  onBack: () => void;
  onOpenThread: (id: string) => void;
}) {
  if (view.kind === "root") {
    return (
      <div className="topbar-crumbs">
        <span className="crumb is-current">All thoughts</span>
        {(query || activeTag) && (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb is-current">
              {query ? `"${query}"` : `#${activeTag}`}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={onClearFilters}
            >
              <Icons.X /> clear
            </button>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="topbar-crumbs">
      <button type="button" className="crumb" onClick={onBack}>
        All thoughts
      </button>
      {thread?.hasMoreAncestors && (
        <>
          <span className="crumb-sep">/</span>
          <span
            className="crumb-more"
            title={`${(thread?.totalAncestors ?? 0) -
              (thread?.ancestors.length ?? 0)} more above`}
          >
            …
          </span>
        </>
      )}
      {thread?.ancestors.map((a) => (
        <Fragment key={a.id}>
          <span className="crumb-sep">/</span>
          <span className="crumb-item">
            <button
              type="button"
              className="crumb"
              onClick={() => onOpenThread(a.id)}
              title={a.text}
            >
              {truncate(a.text, 36)}
            </button>
          </span>
        </Fragment>
      ))}
      <span className="crumb-sep">/</span>
      <span className="crumb is-current">
        {thread ? truncate(thread.note.text, 36) : "Thread"}
      </span>
    </div>
  );
}

// ——— main ———
export default function App(): ReactNode {
  const [view, setView] = useState<View>(() => {
    if (typeof window === "undefined") return { kind: "root" };
    return viewFromPath(window.location.pathname);
  });
  const [roots, setRoots] = useState<Note[]>([]);
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [activeReplyComposerId, setActiveReplyComposerId] = useState<string | null>(
    null,
  );
  const didSyncRouteRef = useRef(false);
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem("threaded-theme");
    if (stored === "dark") return true;
    if (stored === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    window.localStorage.setItem("threaded-theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    const targetPath = pathFromView(view);
    if (window.location.pathname !== targetPath) {
      if (didSyncRouteRef.current) {
        window.history.pushState({}, "", targetPath);
      } else {
        window.history.replaceState({}, "", targetPath);
      }
    }
    didSyncRouteRef.current = true;
  }, [view]);

  useEffect(() => {
    const onPopState = () => {
      setActiveReplyComposerId(null);
      setView(viewFromPath(window.location.pathname));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const refreshRoots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listRoots();
      // newest first in sidebar/feed
      setRoots([...data].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
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
      // Always refresh to keep counts accurate (childCount on parents).
      if (view.kind === "root" && note.parentId === null) {
        setRoots((prev) => [note, ...prev]);
        return;
      }
      if (view.kind === "thread" && note.parentId === view.noteId) {
        setThread((prev) =>
          prev
            ? {
                ...prev,
                note: { ...prev.note, childCount: prev.note.childCount + 1 },
                children: [...prev.children, note],
              }
            : prev,
        );
        return;
      }
      if (view.kind === "root") void refreshRoots();
      else void refreshThread(view.noteId);
    },
    [view, refreshRoots, refreshThread],
  );

  const handleOpenThread = useCallback((id: string) => {
    setActiveReplyComposerId(null);
    setView({ kind: "thread", noteId: id });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const handleBack = useCallback(() => {
    setActiveReplyComposerId(null);
    setView({ kind: "root" });
  }, []);

  // ⌘K focuses search.
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>(
          ".sidebar-search input",
        );
        input?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of roots) {
      for (const tag of extractTags(r.text)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [roots]);

  const filteredRoots = useMemo(() => {
    const q = query.trim().toLowerCase();
    return roots.filter((r) => {
      const textHit = !q || r.text.toLowerCase().includes(q);
      const tagHit = !activeTag || extractTags(r.text).includes(activeTag);
      return textHit && tagHit;
    });
  }, [roots, query, activeTag]);

  const currentRootId = view.kind === "thread" ? view.noteId : null;

  return (
    <div className="app">
      <Sidebar
        roots={roots}
        currentRootId={currentRootId}
        query={query}
        onQueryChange={(q) => {
          setActiveReplyComposerId(null);
          setQuery(q);
          setView({ kind: "root" });
        }}
        activeTag={activeTag}
        onTagClick={(t) => {
          setActiveReplyComposerId(null);
          setActiveTag((prev) => (prev === t ? null : t));
          setView({ kind: "root" });
        }}
        tags={tags}
        onSelect={handleOpenThread}
        onNew={() => {
          setActiveReplyComposerId(null);
          setView({ kind: "root" });
          window.setTimeout(() => {
            document
              .querySelector<HTMLTextAreaElement>(".composer-input")
              ?.focus();
          }, 0);
        }}
      />

      <main className="main">
        <header className="topbar">
          <Breadcrumb
            view={view}
            thread={thread}
            query={query}
            activeTag={activeTag}
            onClearFilters={() => {
              setQuery("");
              setActiveTag(null);
            }}
            onBack={handleBack}
            onOpenThread={handleOpenThread}
          />
          <div className="topbar-right">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setDark((d) => !d)}
              title={dark ? "Switch to light mode" : "Switch to dark mode"}
              aria-label="Toggle theme"
            >
              {dark ? <Icons.Sun /> : <Icons.Moon />}
            </button>
          </div>
        </header>

        <div className="canvas">
          {view.kind === "root" ? (
            <RootView
              roots={filteredRoots}
              loading={loading}
              error={error}
              query={query}
              activeTag={activeTag}
              onCreated={handleCreated}
              onOpenThread={handleOpenThread}
              activeReplyComposerId={activeReplyComposerId}
              onReplyComposerChange={setActiveReplyComposerId}
            />
          ) : (
            <ThreadPage
              thread={thread}
              loading={loading}
              error={error}
              onCreated={handleCreated}
              onOpenThread={handleOpenThread}
              activeReplyComposerId={activeReplyComposerId}
              onReplyComposerChange={setActiveReplyComposerId}
            />
          )}
        </div>
      </main>
    </div>
  );
}
