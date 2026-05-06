/// <reference types="vite/client" />

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
import { DayPicker, type DateRange as DPRange } from "react-day-picker";
import "react-day-picker/style.css";

type Note = {
  id: string;
  spaceId: string;
  parentId: string | null;
  text: string;
  createdAt: string;
  childCount: number;
  tags: string[];
};

type Space = {
  id: string;
  name: string;
  createdAt: string;
};

type ThreadView = {
  note: Note;
  children: Note[];
  ancestors: Note[];
  hasMoreAncestors: boolean;
  totalAncestors: number;
};

type TagStat = {
  name: string;
  count: number;
};

type View =
  | { kind: "root"; spaceId: string | null }
  | { kind: "thread"; spaceId: string | null; noteId: string };

type AuthUser = {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
};

type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: AuthUser };

type SidebarMode = "roots" | "siblings";
type DateRange = { from: string; to: string }; // "YYYY-MM-DD"
type SpaceModalState =
  | { kind: "new" }
  | { kind: "rename"; spaceId: string }
  | { kind: "delete"; spaceId: string }
  | null;

const API_BASE = import.meta.env.VITE_API_TARGET ?? "/api";
const SPACE_ROUTE_PREFIX = "/space/";
const THREAD_ROUTE_PREFIX = "/thread/";

function viewFromPath(pathname: string): View {
  if (pathname.startsWith(SPACE_ROUTE_PREFIX)) {
    const parts = pathname.split("/").filter(Boolean);
    const encodedSpaceId = parts[1];
    const spaceId = encodedSpaceId ? decodeURIComponent(encodedSpaceId) : null;
    if (parts[2] === "thread" && parts[3]) {
      return {
        kind: "thread",
        spaceId,
        noteId: decodeURIComponent(parts[3]),
      };
    }
    return { kind: "root", spaceId };
  }
  if (pathname.startsWith(THREAD_ROUTE_PREFIX)) {
    const encodedId = pathname.slice(THREAD_ROUTE_PREFIX.length);
    if (encodedId) {
      return { kind: "thread", spaceId: null, noteId: decodeURIComponent(encodedId) };
    }
  }
  return { kind: "root", spaceId: null };
}

function pathFromView(view: View): string {
  if (!view.spaceId) return "/";
  const encodedSpaceId = encodeURIComponent(view.spaceId);
  if (view.kind === "thread") {
    return `${SPACE_ROUTE_PREFIX}${encodedSpaceId}${THREAD_ROUTE_PREFIX}${encodeURIComponent(view.noteId)}`;
  }
  return `${SPACE_ROUTE_PREFIX}${encodedSpaceId}`;
}

function viewKey(view: View): string {
  return pathFromView(view);
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent("auth:unauthenticated"));
    throw new Error("Not signed in");
  }
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

function normalizeTagName(tag: string): string {
  return tag.trim().replace(/^#+/, "").toLowerCase();
}

function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const cleaned = normalizeTagName(tag);
    if (!cleaned || !/^\w+$/.test(cleaned) || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function stripInlineTags(text: string): string {
  return text.replace(/(^|\s)#(\w+)/g, "$1").replace(/[ \t]+\n/g, "\n").trim();
}

function buildTagsQuery(tags: string[]): string {
  const normalized = normalizeTags(tags);
  if (normalized.length === 0) return "";
  const params = new URLSearchParams();
  normalized.forEach((tag) => params.append("tag", tag));
  return `&${params.toString()}`;
}

function buildDateRangeQuery(range: DateRange | null): string {
  if (!range) return "";
  return `&dateFrom=${range.from}&dateTo=${range.to}`;
}

function isNoteInDateRange(createdAt: string, range: DateRange): boolean {
  const day = createdAt.slice(0, 10);
  return day >= range.from && day <= range.to;
}

const api = {
  listSpaces: () => http<Space[]>(`${API_BASE}/spaces`),
  createSpace: (name: string) =>
    http<Space>(`${API_BASE}/spaces`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  updateSpace: (id: string, name: string) =>
    http<Space>(`${API_BASE}/spaces/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  deleteSpace: async (id: string) => {
    const res = await fetch(`${API_BASE}/spaces/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
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
  },
  listRoots: (spaceId: string, tags: string[] = [], range: DateRange | null = null) =>
    http<Note[]>(
      `${API_BASE}/notes?spaceId=${encodeURIComponent(spaceId)}${buildTagsQuery(tags)}${buildDateRangeQuery(range)}`,
    ),
  searchNotes: (spaceId: string, query: string, tags: string[] = [], range: DateRange | null = null) =>
    http<Note[]>(
      `${API_BASE}/notes/search?spaceId=${encodeURIComponent(spaceId)}&query=${encodeURIComponent(query)}${buildTagsQuery(tags)}${buildDateRangeQuery(range)}`,
    ),
  listTags: (spaceId: string) =>
    http<TagStat[]>(`${API_BASE}/tags?spaceId=${encodeURIComponent(spaceId)}`),
  listByParent: (spaceId: string, parentId: string) =>
    http<Note[]>(
      `${API_BASE}/notes?spaceId=${encodeURIComponent(spaceId)}&parentId=${encodeURIComponent(parentId)}`,
    ),
  getThread: (spaceId: string, id: string) =>
    http<ThreadView>(
      `${API_BASE}/notes/${encodeURIComponent(id)}/thread?spaceId=${encodeURIComponent(spaceId)}`,
    ),
  createNote: (
    spaceId: string,
    text: string,
    parentId: string | null,
    tags: string[],
  ) =>
    http<Note>(`${API_BASE}/notes`, {
      method: "POST",
      body: JSON.stringify({ text, parentId, spaceId, tags: normalizeTags(tags) }),
    }),
  updateNote: (spaceId: string, id: string, text: string, tags: string[]) =>
    http<Note>(`${API_BASE}/notes/${encodeURIComponent(id)}?spaceId=${encodeURIComponent(spaceId)}`, {
      method: "PATCH",
      body: JSON.stringify({ text, tags: normalizeTags(tags) }),
    }),
  deleteNote: async (spaceId: string, id: string) => {
    const res = await fetch(
      `${API_BASE}/notes/${encodeURIComponent(id)}?spaceId=${encodeURIComponent(spaceId)}`,
      {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      },
    );
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
  },
};

function sortByNewest(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

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

function toDayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtGroupLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  if (sameDay) return "Today";
  if (isYesterday) return "Yest";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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
  ChevronDown: () => (
    <svg {...iconProps} width={12} height={12} aria-hidden="true">
      <path d="m4 6 4 4 4-4" />
    </svg>
  ),
  ArrowLeft: () => (
    <svg {...iconProps} aria-hidden="true">
      <path d="m8 4-4 4 4 4" />
      <path d="M4 8h8" />
    </svg>
  ),
  More: () => (
    <svg {...iconProps} aria-hidden="true">
      <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  Calendar: () => (
    <svg {...iconProps} aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 7h11" />
      <path d="M5.5 2v3M10.5 2v3" />
    </svg>
  ),
  SignOut: () => (
    <svg {...iconProps} aria-hidden="true">
      <path d="M6 3H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h3" />
      <path d="m10 11 3-3-3-3" />
      <path d="M13 8H6" />
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
  "A quiet place to go deep.",
  "The best way to save your thoughts — write them down.",
  "The perfect place to break down your ideas.",
  "Your ideas are precious. Don't let them fade away.",
  "A quiet mind makes loud thoughts.",
  "Today's note is tomorrow's archive.",
  "Your ideas worth noting.",
  "The perfect place to detailize your ideas.",
  "Taking a note is the first step to clarity.",
  "A note is a reminder of what you've learned.",
  "Taking note is the first step in implementing your idea."
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
  spaceId: string;
  parentId: string | null;
  availableTags: string[];
  placeholder: string;
  ctaLabel?: string;
  variant?: "primary" | "inline";
  singleLine?: boolean;
  autoFocus?: boolean;
  onCancel?: () => void;
  onCreated: (note: Note) => void;
};

type TagChipInputProps = {
  tags: string[];
  onChange: (next: string[]) => void;
  suggestions: string[];
  disabled?: boolean;
};

function TagChipInput({
  tags,
  onChange,
  suggestions,
  disabled = false,
}: TagChipInputProps) {
  const [draft, setDraft] = useState("");
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const isTagDraft = draft.startsWith("#");
  const normalizedDraft = normalizeTagName(draft);
  const filteredSuggestions = useMemo(() => {
    if (!isTagDraft) return [];
    const lower = normalizedDraft.toLowerCase();
    return normalizeTags(suggestions).filter(
      (tag) => !tags.includes(tag) && (lower.length === 0 || tag.startsWith(lower)),
    );
  }, [isTagDraft, normalizedDraft, suggestions, tags]);

  useEffect(() => {
    setActiveSuggestion(0);
  }, [normalizedDraft]);

  const addTag = useCallback(
    (raw: string) => {
      const normalized = normalizeTagName(raw);
      if (!normalized || !/^\w+$/.test(normalized) || tags.includes(normalized)) return;
      onChange([...tags, normalized]);
      setDraft("");
      setActiveSuggestion(0);
    },
    [onChange, tags],
  );

  const removeTag = useCallback(
    (name: string) => {
      onChange(tags.filter((tag) => tag !== name));
    },
    [onChange, tags],
  );

  const commitDraft = useCallback(() => {
    if (!draft.startsWith("#")) return;
    if (filteredSuggestions.length > 0) {
      addTag(filteredSuggestions[Math.min(activeSuggestion, filteredSuggestions.length - 1)]);
      return;
    }
    addTag(draft);
  }, [activeSuggestion, addTag, draft, filteredSuggestions]);

  const onDraftKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!draft) {
      if (event.key === "Backspace" && tags.length > 0) {
        event.preventDefault();
        removeTag(tags[tags.length - 1]);
      }
      return;
    }
    if (event.key === "ArrowDown" && filteredSuggestions.length > 0) {
      event.preventDefault();
      setActiveSuggestion((prev) => (prev + 1) % filteredSuggestions.length);
      return;
    }
    if (event.key === "ArrowUp" && filteredSuggestions.length > 0) {
      event.preventDefault();
      setActiveSuggestion((prev) =>
        prev === 0 ? filteredSuggestions.length - 1 : prev - 1,
      );
      return;
    }
    if (event.key === "Enter" || event.key === "Tab" || event.key === " " || event.key === ",") {
      if (!draft.startsWith("#")) return;
      event.preventDefault();
      commitDraft();
      return;
    }
    if (event.key === "Escape") {
      setDraft("");
    }
  };

  return (
    <div className="tag-editor">
      {tags.length > 0 && (
        <div className="tag-editor-chips">
          {tags.map((tag) => (
            <span key={tag} className="tag-editor-chip">
              #{tag}
              <button
                type="button"
                className="tag-editor-chip-remove"
                onClick={() => removeTag(tag)}
                aria-label={`Remove ${tag} tag`}
                disabled={disabled}
              >
                <Icons.X />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="tag-editor-input-wrap">
        <input
          className="tag-editor-input"
          placeholder="Type #tag and press Space"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onDraftKeyDown}
          disabled={disabled}
        />
        {isTagDraft && filteredSuggestions.length > 0 && (
          <div className="tag-editor-suggestions" role="listbox" aria-label="Tag suggestions">
            {filteredSuggestions.map((tag, index) => (
              <button
                key={tag}
                type="button"
                className={`tag-editor-suggestion ${index === activeSuggestion ? "is-active" : ""}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  addTag(tag);
                }}
                role="option"
                aria-selected={index === activeSuggestion}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function DateRangePicker({
  value,
  onChange,
  onClose,
}: {
  value: DateRange | null;
  onChange: (range: DateRange | null) => void;
  onClose: () => void;
}) {
  const [pending, setPending] = useState<DPRange | undefined>(
    value ? { from: new Date(value.from), to: new Date(value.to) } : undefined,
  );

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleApply = () => {
    if (pending?.from && pending?.to) {
      onChange({ from: toDateStr(pending.from), to: toDateStr(pending.to) });
    } else if (pending?.from) {
      onChange({ from: toDateStr(pending.from), to: toDateStr(pending.from) });
    }
  };

  const handleClear = () => {
    setPending(undefined);
    onChange(null);
  };

  return (
    <div className="date-picker">
      <DayPicker
        mode="range"
        selected={pending}
        onSelect={setPending}
        weekStartsOn={1}
      />
      <div className="date-picker-footer">
        <button type="button" className="btn btn-ghost btn-xs" onClick={handleClear}>
          Clear
        </button>
        <button
          type="button"
          className="btn btn-xs"
          onClick={handleApply}
          disabled={!pending?.from}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

function Composer({
  spaceId,
  parentId,
  availableTags,
  placeholder,
  ctaLabel = "Add thought",
  variant = "primary",
  singleLine = false,
  autoFocus,
  onCancel,
  onCreated,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const submit = useCallback(
    async (event?: FormEvent) => {
      event?.preventDefault();
      const trimmed = stripInlineTags(text);
      const normalizedTags = normalizeTags(tags);
      if (!trimmed) return;
      setSubmitting(true);
      setError(null);
      try {
        const note = await api.createNote(spaceId, trimmed, parentId, normalizedTags);
        setText("");
        setTags([]);
        onCreated(note);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not save note");
      } finally {
        setSubmitting(false);
      }
    },
    [spaceId, text, parentId, onCreated, tags],
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
    <form
      className={`composer ${compact ? "is-compact" : ""} ${singleLine && !compact ? "is-single-line" : ""}`}
      onSubmit={submit}
    >
      <textarea
        ref={ref}
        className="composer-input"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={compact ? 2 : singleLine ? 1 : 4}
        disabled={submitting}
      />
      <TagChipInput
        tags={tags}
        onChange={setTags}
        suggestions={availableTags}
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
  availableTags: string[];
  isChildCard?: boolean;
  timestampStyle?: "full" | "time-only" | "hidden";
  showRepliesChip?: boolean;
  onOpenThread: (noteId: string) => void;
  onCreated: (note: Note) => void;
  onUpdated: (noteId: string, text: string, tags: string[]) => Promise<void>;
  onDeleted: (note: Note) => Promise<void>;
  activeReplyComposerId: string | null;
  onReplyComposerChange: (noteId: string | null) => void;
  isFocused?: boolean;
};

function ThoughtCard({
  note,
  availableTags,
  isChildCard = false,
  timestampStyle = "full",
  showRepliesChip = true,
  onOpenThread,
  onCreated,
  onUpdated,
  onDeleted,
  activeReplyComposerId,
  onReplyComposerChange,
  isFocused,
}: ThoughtCardProps) {
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState(note.text);
  const [draftTags, setDraftTags] = useState<string[]>(note.tags ?? []);
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
  const replying = activeReplyComposerId === note.id;
  const tags = note.tags ?? [];
  const displayText = note.text;
  const replies = note.childCount;

  useEffect(() => {
    if (!isEditing) {
      setDraftText(note.text);
      setDraftTags(note.tags ?? []);
      setEditError(null);
    }
  }, [note.text, note.tags, isEditing]);

  useEffect(() => {
    if (!isEditing) return;
    setIsActionsMenuOpen(false);
  }, [isEditing]);

  useEffect(() => {
    if (!isActionsMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (actionsMenuRef.current?.contains(event.target as Node)) return;
      setIsActionsMenuOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setIsActionsMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isActionsMenuOpen]);

  useEffect(() => {
    if (!showDeleteDialog) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) {
        setShowDeleteDialog(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showDeleteDialog, deleting]);

  const cancelEdit = useCallback(() => {
    if (savingEdit) return;
    setIsEditing(false);
    setDraftText(note.text);
    setDraftTags(note.tags ?? []);
    setEditError(null);
  }, [savingEdit, note.text, note.tags]);

  const openEditor = useCallback(() => {
    onReplyComposerChange(null);
    setIsEditing(true);
    setDraftText(note.text);
    setDraftTags(note.tags ?? []);
    setEditError(null);
    setIsActionsMenuOpen(false);
  }, [note.text, note.tags, onReplyComposerChange]);

  const submitEdit = useCallback(async () => {
    const trimmed = stripInlineTags(draftText);
    const normalizedTags = normalizeTags(draftTags);
    if (!trimmed) return;
    if (
      trimmed === note.text &&
      normalizedTags.join(",") === normalizeTags(note.tags ?? []).join(",")
    ) {
      setIsEditing(false);
      setEditError(null);
      return;
    }
    setSavingEdit(true);
    setEditError(null);
    try {
      await onUpdated(note.id, trimmed, normalizedTags);
      setIsEditing(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Could not save note");
    } finally {
      setSavingEdit(false);
    }
  }, [draftText, draftTags, note.id, note.text, note.tags, onUpdated]);

  const onEditKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void submitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  const handleDelete = useCallback(async () => {
    if (savingEdit || deleting) return;
    setDeleting(true);
    setIsActionsMenuOpen(false);
    try {
      await onDeleted(note);
      if (activeReplyComposerId === note.id) {
        onReplyComposerChange(null);
      }
    } catch {
      // App-level handler already sets the error banner.
    } finally {
      setDeleting(false);
      setShowDeleteDialog(false);
    }
  }, [
    savingEdit,
    deleting,
    note,
    onDeleted,
    activeReplyComposerId,
    onReplyComposerChange,
  ]);

  const onDeleteAction = useCallback(() => {
    if (note.childCount > 0) {
      setIsActionsMenuOpen(false);
      setShowDeleteDialog(true);
      return;
    }
    void handleDelete();
  }, [note.childCount, handleDelete]);

  return (
    <div
      className={`thought ${isFocused ? "is-focused" : ""} ${isChildCard ? "is-child" : ""}`.trim()}
    >
      <article className="thought-card">
        {isEditing ? (
          <div className="thought-edit-wrap">
            <textarea
              className="thought-edit-input"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onKeyDown={onEditKeyDown}
              rows={3}
              disabled={savingEdit}
              autoFocus
            />
            <TagChipInput
              tags={draftTags}
              onChange={setDraftTags}
              suggestions={availableTags}
              disabled={savingEdit}
            />
            <div className="thought-edit-row">
              {editError ? (
                <span className="composer-error">{editError}</span>
              ) : (
                <span className="composer-hint">
                  <kbd>⌘</kbd>
                  <kbd>↵</kbd>
                  <span className="composer-hint-text">to save</span>
                </span>
              )}
              <div className="composer-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={cancelEdit}
                  disabled={savingEdit}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void submitEdit()}
                  disabled={savingEdit || !draftText.trim()}
                >
                  {savingEdit ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <p className="thought-body">{displayText}</p>
        )}
        <div className="thought-meta">
          <div className="thought-meta-left">
            {timestampStyle !== "hidden" && (
              <time className="ts" dateTime={note.createdAt}>
                {timestampStyle === "time-only" ? fmtTime(note.createdAt) : fmtTimestamp(note.createdAt)}
              </time>
            )}
            {showRepliesChip && replies > 0 && (
              <>
                {timestampStyle !== "hidden" && (
                  <span className="meta-sep" aria-hidden="true">
                    •
                  </span>
                )}
                <button
                  type="button"
                  className="meta-inline-btn"
                  onClick={() => onOpenThread(note.id)}
                  title="Open replies"
                >
                  {replies} {replies === 1 ? "reply" : "replies"} <Icons.Chevron />
                </button>
              </>
            )}
          </div>
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
          {!isEditing && (
            <div
              className={`thought-actions ${isActionsMenuOpen ? "is-open" : ""}`}
              ref={actionsMenuRef}
            >
              <button
                type="button"
                className={`meta-btn meta-btn--icon meta-more-btn ${isActionsMenuOpen ? "is-active" : ""}`}
                onClick={() => setIsActionsMenuOpen((prev) => !prev)}
                aria-label="Open thought menu"
                aria-expanded={isActionsMenuOpen}
                aria-haspopup="menu"
                title="More"
              >
                <Icons.More />
              </button>
              <div
                className={`thought-context-menu ${isActionsMenuOpen ? "is-open" : ""}`}
                role="menu"
              >
                <button
                  type="button"
                  className="thought-context-item"
                  onClick={openEditor}
                  role="menuitem"
                  disabled={savingEdit || deleting}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="thought-context-item thought-context-item--danger"
                  onClick={onDeleteAction}
                  role="menuitem"
                  disabled={savingEdit || deleting}
                >
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            className={`meta-btn ${replying ? "is-active" : ""}`}
            onClick={() => {
              if (isEditing) {
                cancelEdit();
              }
              onReplyComposerChange(replying ? null : note.id);
            }}
            aria-label={replying ? "Close reply composer" : "Write a reply"}
            title={replying ? "Close reply composer" : "Write a reply"}
            disabled={savingEdit || deleting}
          >
            <Icons.Reply />
          </button>
        </div>
      </article>
      {replying && (
        <div className="thought-reply">
          <Composer
            spaceId={note.spaceId}
            parentId={note.id}
            availableTags={availableTags}
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
      {showDeleteDialog && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onClick={() => {
            if (!deleting) setShowDeleteDialog(false);
          }}
        >
          <section
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`delete-dialog-title-${note.id}`}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id={`delete-dialog-title-${note.id}`} className="dialog-title">
              Delete thought?
            </h3>
            <p className="dialog-body">
              This will delete this thought and its {note.childCount}{" "}
              {note.childCount === 1 ? "reply" : "replies"}.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setShowDeleteDialog(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void handleDelete()}
                disabled={deleting}
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

// ——— sidebar ———
type SidebarProps = {
  spaces: Space[];
  activeSpaceId: string | null;
  onSelectSpace: (spaceId: string) => void;
  onCreateSpace: () => void;
  onRenameSpace: (spaceId: string) => void;
  onDeleteSpace: (spaceId: string) => void;
  items: Note[];
  mode: SidebarMode;
  currentThreadId: string | null;
  query: string;
  onQueryChange: (q: string) => void;
  selectedTags: string[];
  onTagClick: (tag: string) => void;
  tags: TagStat[];
  onSelect: (id: string) => void;
  onNew: () => void;
  dateRange: DateRange | null;
  onDateRangeChange: (range: DateRange | null) => void;
};

function Sidebar({
  spaces,
  activeSpaceId,
  onSelectSpace,
  onCreateSpace,
  onRenameSpace,
  onDeleteSpace,
  items,
  mode,
  currentThreadId,
  query,
  onQueryChange,
  selectedTags,
  onTagClick,
  tags,
  onSelect,
  onNew,
  dateRange,
  onDateRangeChange,
}: SidebarProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [isSpaceSelectOpen, setIsSpaceSelectOpen] = useState(false);
  const [isSpaceMenuOpen, setIsSpaceMenuOpen] = useState(false);
  const [isCalOpen, setIsCalOpen] = useState(false);
  const currentSpace = spaces.find((space) => space.id === activeSpaceId) ?? spaces[0] ?? null;

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
  }, [items.length]);

  useLayoutEffect(() => {
    if (!currentThreadId) return;
    const list = listRef.current;
    if (!list) return;
    const activeItem = list.querySelector<HTMLButtonElement>(
      ".thread-item.is-active",
    );
    if (!activeItem) return;
    activeItem.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [currentThreadId, items]);

  useEffect(() => {
    if (!isSpaceMenuOpen && !isSpaceSelectOpen && !isCalOpen) return;
    const onPointerDown = (event: globalThis.MouseEvent) => {
      const target = event.target as Element | null;
      const control = target?.closest<HTMLElement>(".sidebar-space-control");
      if (control) return;
      setIsSpaceSelectOpen(false);
      setIsSpaceMenuOpen(false);
      if (!target?.closest(".sidebar-search")) {
        setIsCalOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [isSpaceMenuOpen, isSpaceSelectOpen, isCalOpen]);

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

      <div className="sidebar-section">
        <div className="sidebar-label">Space</div>
        <div className="sidebar-space-control">
          <div className="sidebar-space-selector">
            <button
              type="button"
              className={`sidebar-space-trigger ${isSpaceSelectOpen ? "is-open" : ""}`}
              onClick={() => {
                setIsSpaceMenuOpen(false);
                setIsSpaceSelectOpen((prev) => !prev);
              }}
              aria-haspopup="listbox"
              aria-expanded={isSpaceSelectOpen}
              aria-label="Select space"
            >
              <span className="sidebar-space-trigger-label">
                {currentSpace?.name ?? "Select space"}
              </span>
              <span className={`sidebar-space-trigger-chevron ${isSpaceSelectOpen ? "is-open" : ""}`}>
                <Icons.ChevronDown />
              </span>
            </button>
            {isSpaceSelectOpen && (
              <div className="sidebar-space-dropdown" role="listbox" aria-label="Spaces">
                {spaces.map((space) => (
                  <button
                    key={space.id}
                    type="button"
                    className={`sidebar-space-option ${activeSpaceId === space.id ? "is-active" : ""}`}
                    role="option"
                    aria-selected={activeSpaceId === space.id}
                    onClick={() => {
                      setIsSpaceSelectOpen(false);
                      onSelectSpace(space.id);
                    }}
                  >
                    {space.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="sidebar-space-add"
            onClick={onCreateSpace}
            aria-label="Create new space"
            title="New space"
          >
            <Icons.Plus />
          </button>
          <div className="sidebar-space-menu">
            <button
              type="button"
              className="sidebar-space-menu-trigger sidebar-space-menu-trigger--visible"
              aria-label="Space actions"
              onClick={(e) => {
                e.stopPropagation();
                setIsSpaceSelectOpen(false);
                setIsSpaceMenuOpen((prev) => !prev);
              }}
            >
              <Icons.More />
            </button>
            {isSpaceMenuOpen && (
              <div className="sidebar-space-menu-popover" role="menu">
                <button
                  type="button"
                  className="sidebar-space-menu-item"
                  onClick={() => {
                    setIsSpaceMenuOpen(false);
                    if (activeSpaceId) onRenameSpace(activeSpaceId);
                  }}
                  role="menuitem"
                  disabled={!activeSpaceId}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="sidebar-space-menu-item sidebar-space-menu-item--danger"
                  onClick={() => {
                    setIsSpaceMenuOpen(false);
                    if (activeSpaceId) onDeleteSpace(activeSpaceId);
                  }}
                  role="menuitem"
                  disabled={!activeSpaceId}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {tags.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-label">Tags</div>
          <div className="sidebar-tags">
            {tags.map((t) => (
              <button
                key={t.name}
                type="button"
                className={`chip ${selectedTags.includes(t.name) ? "is-active" : ""}`}
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
          {mode === "siblings" ? "Siblings" : "All threads"}{" "}
          <span className="muted">{items.length}</span>
        </div>
        <div className="sidebar-search" style={{ position: "relative" }}>
          <Icons.Search />
          <input
            placeholder="Search"
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
          <button
            type="button"
            className={`search-clear search-cal-btn${dateRange ? " is-active" : ""}`}
            onClick={() => setIsCalOpen((prev) => !prev)}
            aria-label={dateRange ? "Date filter active — click to change" : "Filter by date"}
            title="Filter by date"
          >
            <Icons.Calendar />
          </button>
          {isCalOpen && (
            <DateRangePicker
              value={dateRange}
              onChange={(r) => {
                onDateRangeChange(r);
                setIsCalOpen(false);
              }}
              onClose={() => setIsCalOpen(false)}
            />
          )}
        </div>
        <div className="sidebar-list-wrap">
          <div className="sidebar-list" ref={listRef}>
            {items.length === 0 ? (
              <div className="muted small sidebar-empty">
                {mode === "siblings" ? "No sibling threads." : "No thoughts yet."}
              </div>
            ) : (
              items.map((r) => {
                const isActive = currentThreadId === r.id;
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
    </aside>
  );
}

// ——— empty state ———
function EmptyState({
  query,
  selectedTags,
}: {
  query: string;
  selectedTags: string[];
}) {
  if (query || selectedTags.length > 0) {
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
  activeSpaceId: string;
  availableTags: string[];
  roots: Note[];
  loading: boolean;
  error: string | null;
  query: string;
  selectedTags: string[];
  headerCompact: boolean;
  onCreated: (note: Note) => void;
  onUpdated: (noteId: string, text: string, tags: string[]) => Promise<void>;
  onDeleted: (note: Note) => Promise<void>;
  onOpenThread: (id: string) => void;
  activeReplyComposerId: string | null;
  onReplyComposerChange: (noteId: string | null) => void;
};

function RootView({
  activeSpaceId,
  availableTags,
  roots,
  loading,
  error,
  query,
  selectedTags,
  headerCompact,
  onCreated,
  onUpdated,
  onDeleted,
  onOpenThread,
  activeReplyComposerId,
  onReplyComposerChange,
}: RootViewProps) {
  const groupedRoots = useMemo(() => {
    const out: { key: string; label: string; notes: Note[] }[] = [];
    const groupIndexByKey = new Map<string, number>();
    for (const root of roots) {
      const key = toDayKey(root.createdAt) || root.createdAt;
      const existingIdx = groupIndexByKey.get(key);
      if (existingIdx === undefined) {
        groupIndexByKey.set(key, out.length);
        out.push({
          key,
          label: fmtGroupLabel(root.createdAt) || "Unknown",
          notes: [root],
        });
        continue;
      }
      out[existingIdx].notes.push(root);
    }
    return out;
  }, [roots]);

  return (
    <>
      <section className="root-header">
        <section className="hero">
          <Wordmark />
          <p className="hero-sub">
            <RotatingTagline />
          </p>
        </section>

        <section className="composer-wrap">
          <Composer
            spaceId={activeSpaceId}
            parentId={null}
            availableTags={availableTags}
            placeholder="What's on your mind?"
            ctaLabel="Add thought"
            singleLine={headerCompact}
            onCreated={onCreated}
          />
        </section>
      </section>

      {error && <div className="banner banner-error">{error}</div>}

      {loading && roots.length === 0 ? (
        <div className="loading">Loading thoughts…</div>
      ) : roots.length === 0 ? (
        <EmptyState query={query} selectedTags={selectedTags} />
      ) : (
        <section className="feed">
          {groupedRoots.map((group) => (
            <section key={group.key} className="feed-date-group" aria-label={`${group.label} thoughts`}>
              <time className="feed-date-rail" dateTime={group.key}>
                {group.label}
              </time>
              <div className="feed-date-items">
                {group.notes.map((root) => (
                  <article key={root.id} className="feed-item">
                    <ThoughtCard
                      note={root}
                      availableTags={availableTags}
                      timestampStyle="time-only"
                      onOpenThread={onOpenThread}
                      onCreated={onCreated}
                      onUpdated={onUpdated}
                      onDeleted={onDeleted}
                      activeReplyComposerId={activeReplyComposerId}
                      onReplyComposerChange={onReplyComposerChange}
                    />
                  </article>
                ))}
              </div>
            </section>
          ))}
        </section>
      )}
    </>
  );
}

// ——— thread view ———
type ThreadPageProps = {
  thread: ThreadView | null;
  availableTags: string[];
  loading: boolean;
  error: string | null;
  threadHeaderCompact: boolean;
  onGoUpLevel: () => void;
  onCreated: (note: Note) => void;
  onUpdated: (noteId: string, text: string, tags: string[]) => Promise<void>;
  onDeleted: (note: Note) => Promise<void>;
  onOpenThread: (id: string) => void;
  activeReplyComposerId: string | null;
  onReplyComposerChange: (noteId: string | null) => void;
};

function ThreadPage({
  thread,
  availableTags,
  loading,
  error,
  threadHeaderCompact,
  onGoUpLevel,
  onCreated,
  onUpdated,
  onDeleted,
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
      <section className={`thread-focus-header ${threadHeaderCompact ? "is-compact" : ""}`}>
        <div className="thread-view-header">
          <div className="thread-view-heading">
            <button
              type="button"
              className="thread-level-up"
              onClick={onGoUpLevel}
              aria-label="Go to previous thread level"
              title="Previous level"
            >
              <Icons.ArrowLeft />
            </button>
            <div className="muted small">Following the thread.</div>
          </div>
          <div className="thread-stats">
            {children.length} {children.length === 1 ? "reply" : "replies"}
          </div>
        </div>
        <div className="thread-focus-card">
          <ThoughtCard
            note={note}
            availableTags={availableTags}
            showRepliesChip={false}
            onOpenThread={onOpenThread}
            onCreated={onCreated}
            onUpdated={onUpdated}
            onDeleted={onDeleted}
            activeReplyComposerId={activeReplyComposerId}
            onReplyComposerChange={onReplyComposerChange}
            isFocused
          />
        </div>
      </section>

      {error && <div className="banner banner-error">{error}</div>}

      {children.length > 0 && (
        <div className="node__children">
          {children.map((child) => (
            <div key={child.id} className="node depth-1">
              <div className="node-content">
                <ThoughtCard
                  note={child}
                  availableTags={availableTags}
                  onOpenThread={onOpenThread}
                  onCreated={onCreated}
                  onUpdated={onUpdated}
                  onDeleted={onDeleted}
                  activeReplyComposerId={activeReplyComposerId}
                  onReplyComposerChange={onReplyComposerChange}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ——— breadcrumb (topbar) ———
function Breadcrumb({
  view,
  currentSpaceName,
  thread,
  query,
  selectedTags,
  dateRange,
  onClearFilters,
  onBack,
  onOpenThread,
}: {
  view: View;
  currentSpaceName: string;
  thread: ThreadView | null;
  query: string;
  selectedTags: string[];
  dateRange: DateRange | null;
  onClearFilters: () => void;
  onBack: () => void;
  onOpenThread: (id: string) => void;
}) {
  if (view.kind === "root") {
    const hasFilters = query || selectedTags.length > 0 || dateRange;
    const filterLabel = query
      ? `"${query}"`
      : dateRange
        ? `${dateRange.from} → ${dateRange.to}`
        : selectedTags.map((tag) => `#${tag}`).join(" + ");
    return (
      <div className="topbar-crumbs">
        <span className="crumb">{currentSpaceName}</span>
        <span className="crumb-sep">/</span>
        <span className="crumb is-current">All thoughts</span>
        {hasFilters && (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb is-current">{filterLabel}</span>
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
      <span className="crumb">{currentSpaceName}</span>
      <span className="crumb-sep">/</span>
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
// ——— welcome (first space) ———
function WelcomeScreen({
  onCreated,
}: {
  onCreated: (space: Space) => void;
}): ReactNode {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setErr("Space name cannot be empty"); return; }
    setBusy(true);
    setErr(null);
    try {
      const space = await api.createSpace(trimmed);
      onCreated(space);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Could not create space");
      setBusy(false);
    }
  };

  return (
    <div className="app welcome-screen">
      <main className="welcome-main">
        <div className="welcome-icon" aria-hidden="true">✦</div>
        <h1 className="welcome-heading">Let's create your first space</h1>
        <p className="welcome-sub">
          A space holds related thoughts. You can add more later.
        </p>
        <form className="welcome-form" onSubmit={(e) => void handleSubmit(e)}>
          <input
            className="welcome-input"
            type="text"
            placeholder="e.g. Work, Personal, Research…"
            value={name}
            onChange={(e) => { setName(e.target.value); setErr(null); }}
            autoFocus
            disabled={busy}
            maxLength={120}
          />
          {err && <p className="welcome-err">{err}</p>}
          <button className="btn welcome-btn" type="submit" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create space"}
          </button>
        </form>
      </main>
    </div>
  );
}

// ——— login ———
function LoginScreen(): ReactNode {
  return (
    <div className="app login-screen">
      <main className="login-main">
        <h1 className="login-wordmark">Threaded</h1>
        <p className="login-tagline">A quiet place to go deep.</p>
        <a href="/api/auth/google/login" className="btn btn-google">
          Sign in with Google
        </a>
      </main>
    </div>
  );
}

// ——— main ———
export default function App(): ReactNode {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    http<AuthUser>(`${API_BASE}/auth/me`)
      .then((user) => setAuth({ status: "authenticated", user }))
      .catch(() => setAuth({ status: "unauthenticated" }));
  }, []);

  useEffect(() => {
    const handler = () => setAuth({ status: "unauthenticated" });
    window.addEventListener("auth:unauthenticated", handler);
    return () => window.removeEventListener("auth:unauthenticated", handler);
  }, []);

  const handleLogout = useCallback(async () => {
    await fetch(`${API_BASE}/auth/logout`, { method: "POST", credentials: "include" });
    setAuth({ status: "unauthenticated" });
  }, []);

  const [view, setView] = useState<View>(() => {
    if (typeof window === "undefined") return { kind: "root", spaceId: null };
    return viewFromPath(window.location.pathname);
  });
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [roots, setRoots] = useState<Note[]>([]);
  const [spaceTags, setSpaceTags] = useState<TagStat[]>([]);
  const [sidebarThreads, setSidebarThreads] = useState<Note[]>([]);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("roots");
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [activeReplyComposerId, setActiveReplyComposerId] = useState<string | null>(
    null,
  );
  const [spaceModal, setSpaceModal] = useState<SpaceModalState>(null);
  const [spaceNameDraft, setSpaceNameDraft] = useState("");
  const [spaceModalBusy, setSpaceModalBusy] = useState(false);
  const [spaceModalError, setSpaceModalError] = useState<string | null>(null);
  const didSyncRouteRef = useRef(false);
  const rootsRequestSeqRef = useRef(0);
  const scrollPositionsRef = useRef<Map<string, number>>(new Map());
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const stored = window.localStorage.getItem("threaded-theme");
    if (stored === "dark") return true;
    if (stored === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [isHeaderCompact, setIsHeaderCompact] = useState(false);
  const [isThreadHeaderCompact, setIsThreadHeaderCompact] = useState(false);
  const fallbackSpaceId = spaces[0]?.id ?? null;
  const currentSpaceId = view.spaceId ?? fallbackSpaceId;
  const currentSpaceName =
    spaces.find((space) => space.id === currentSpaceId)?.name ?? "Space";

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    window.localStorage.setItem("threaded-theme", dark ? "dark" : "light");
  }, [dark]);

  const [spacesLoaded, setSpacesLoaded] = useState(false);

  const refreshSpaces = useCallback(async () => {
    try {
      const data = await api.listSpaces();
      setSpaces(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load spaces");
    } finally {
      setSpacesLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refreshSpaces();
  }, [refreshSpaces]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedQuery(query);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [query]);

  useEffect(() => {
    let rafId = 0;
    const updateHeaderState = () => {
      const rootCompact = window.scrollY > 42;
      const threadCompact = window.scrollY > 68;
      setIsHeaderCompact((prev) => (prev === rootCompact ? prev : rootCompact));
      setIsThreadHeaderCompact((prev) =>
        prev === threadCompact ? prev : threadCompact,
      );
      rafId = 0;
    };
    const onScroll = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(updateHeaderState);
    };
    updateHeaderState();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, []);

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
      const nextView = viewFromPath(window.location.pathname);
      scrollPositionsRef.current.set(viewKey(view), window.scrollY);
      pendingScrollRestoreRef.current =
        scrollPositionsRef.current.get(viewKey(nextView)) ?? 0;
      setActiveReplyComposerId(null);
      setView(nextView);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [view]);

  useEffect(() => {
    if (spaces.length === 0) return;
    const active = view.spaceId;
    const isKnownSpace = !!active && spaces.some((space) => space.id === active);
    if (isKnownSpace) return;
    const nextSpaceId = spaces[0].id;
    setView({ kind: "root", spaceId: nextSpaceId });
  }, [view.spaceId, spaces]);

  useLayoutEffect(() => {
    if (pendingScrollRestoreRef.current === null) return;
    if (loading) return;
    const readyForRestore =
      view.kind === "root" ||
      thread?.note.id === view.noteId ||
      (view.kind === "thread" && !!error);
    if (!readyForRestore) return;

    const scrollTop = pendingScrollRestoreRef.current;
    pendingScrollRestoreRef.current = null;
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: scrollTop, behavior: "auto" });
    });
  }, [view, loading, thread, error]);

  const navigateToView = useCallback(
    (nextView: View) => {
      scrollPositionsRef.current.set(viewKey(view), window.scrollY);
      pendingScrollRestoreRef.current =
        scrollPositionsRef.current.get(viewKey(nextView)) ?? 0;
      setActiveReplyComposerId(null);
      setView(nextView);
    },
    [view],
  );

  const refreshTags = useCallback(async (spaceId: string) => {
    try {
      const data = await api.listTags(spaceId);
      setSpaceTags(data);
    } catch {
      setSpaceTags([]);
    }
  }, []);

  const refreshRoots = useCallback(
    async (spaceId: string, textQuery: string, tagFilters: string[], range: DateRange | null) => {
    const requestSeq = rootsRequestSeqRef.current + 1;
    rootsRequestSeqRef.current = requestSeq;
    setLoading(true);
    setError(null);
    try {
      const trimmedQuery = textQuery.trim();
      const data = trimmedQuery
          ? await api.searchNotes(spaceId, trimmedQuery, tagFilters, range)
          : await api.listRoots(spaceId, tagFilters, range);
        await refreshTags(spaceId);
      if (requestSeq !== rootsRequestSeqRef.current) return;
      setRoots(sortByNewest(data));
    } catch (err) {
      if (requestSeq !== rootsRequestSeqRef.current) return;
      setError(err instanceof Error ? err.message : "Could not load notes");
    } finally {
      if (requestSeq !== rootsRequestSeqRef.current) return;
      setLoading(false);
    }
    },
    [refreshTags],
  );

  const refreshThread = useCallback(async (spaceId: string, noteId: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getThread(spaceId, noteId);
      setThread(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load thread");
      setThread(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!currentSpaceId) return;
    void refreshTags(currentSpaceId);
  }, [currentSpaceId, refreshTags]);

  useEffect(() => {
    if (!currentSpaceId) return;
    if (view.kind === "root") {
      void refreshRoots(currentSpaceId, debouncedQuery, selectedTags, dateRange);
    } else {
      void refreshThread(currentSpaceId, view.noteId);
    }
  }, [view, currentSpaceId, debouncedQuery, selectedTags, dateRange, refreshRoots, refreshThread]);

  useEffect(() => {
    if (!currentSpaceId) return;
    const setRootsSidebar = () => {
      setSidebarMode("roots");
      setSidebarThreads(roots);
    };

    if (view.kind === "root") {
      setRootsSidebar();
      return;
    }
    if (!thread || thread.note.id !== view.noteId) {
      return;
    }
    if (thread.note.parentId === null) {
      setRootsSidebar();
      return;
    }
    const parentId = thread.note.parentId;

    let cancelled = false;
    const selectedNoteId = view.noteId;
    setSidebarMode("siblings");

    void (async () => {
      try {
        const siblings = await api.listByParent(currentSpaceId, parentId);
        if (cancelled) return;
        if (view.kind !== "thread" || view.noteId !== selectedNoteId) return;
        setSidebarThreads(sortByNewest(siblings));
      } catch {
        if (cancelled) return;
        if (view.kind !== "thread" || view.noteId !== selectedNoteId) return;
        setSidebarThreads([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [view, thread, roots, currentSpaceId]);

  const handleCreated = useCallback(
    (note: Note) => {
      // Always refresh to keep counts accurate (childCount on parents).
      if (view.kind === "root" && note.parentId === null) {
        const matchesActiveFilters =
          (selectedTags.length === 0 || selectedTags.every((tag) => note.tags.includes(tag))) &&
          (!dateRange || isNoteInDateRange(note.createdAt, dateRange));
        if (matchesActiveFilters) {
          setRoots((prev) => [note, ...prev]);
        }
        if (currentSpaceId) void refreshTags(currentSpaceId);
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
      if (!currentSpaceId) return;
      void refreshTags(currentSpaceId);
      if (view.kind === "root") void refreshRoots(currentSpaceId, debouncedQuery, selectedTags, dateRange);
      else void refreshThread(currentSpaceId, view.noteId);
    },
    [view, debouncedQuery, dateRange, refreshRoots, refreshThread, refreshTags, selectedTags, currentSpaceId],
  );

  const handleOpenThread = useCallback(
    (id: string) => {
      if (!currentSpaceId) return;
      navigateToView({ kind: "thread", spaceId: currentSpaceId, noteId: id });
    },
    [navigateToView, currentSpaceId],
  );

  const handleBack = useCallback(() => {
    if (!currentSpaceId) return;
    navigateToView({ kind: "root", spaceId: currentSpaceId });
  }, [navigateToView, currentSpaceId]);

  const handleGoUpLevel = useCallback(() => {
    const parentId = thread?.note.parentId;
    if (parentId) {
      handleOpenThread(parentId);
      return;
    }
    handleBack();
  }, [thread, handleOpenThread, handleBack]);

  const handleUpdated = useCallback(
    async (noteId: string, text: string, tags: string[]) => {
      if (!currentSpaceId) return;
      try {
        const updated = await api.updateNote(currentSpaceId, noteId, text, tags);
        setError(null);

        setRoots((prev) =>
          prev.map((note) =>
            note.id === updated.id ? { ...note, text: updated.text, tags: updated.tags } : note,
          ),
        );
        setSidebarThreads((prev) =>
          prev.map((note) =>
            note.id === updated.id ? { ...note, text: updated.text, tags: updated.tags } : note,
          ),
        );
        setThread((prev) => {
          if (!prev) return prev;
          const patch = (note: Note): Note =>
            note.id === updated.id ? { ...note, text: updated.text, tags: updated.tags } : note;
          return {
            ...prev,
            note: patch(prev.note),
            ancestors: prev.ancestors.map(patch),
            children: prev.children.map(patch),
          };
        });

        // Keep expanded descendants in sync when they are not in local thread state.
        void refreshTags(currentSpaceId);
        if (view.kind === "root") void refreshRoots(currentSpaceId, debouncedQuery, selectedTags);
        else void refreshThread(currentSpaceId, view.noteId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not update note";
        setError(message);
        throw err;
      }
    },
    [
      view,
      debouncedQuery,
      refreshRoots,
      refreshThread,
      refreshTags,
      selectedTags,
      currentSpaceId,
    ],
  );

  const handleDeleted = useCallback(
    async (note: Note) => {
      if (!currentSpaceId) return;
      try {
        await api.deleteNote(currentSpaceId, note.id);
        setError(null);
        void refreshTags(currentSpaceId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not delete note";
        setError(message);
        throw err;
      }

      setActiveReplyComposerId((prev) => (prev === note.id ? null : prev));
      setRoots((prev) => prev.filter((candidate) => candidate.id !== note.id));
      setSidebarThreads((prev) => prev.filter((candidate) => candidate.id !== note.id));

      const deletedFocused = view.kind === "thread" && view.noteId === note.id;
      const deletedAncestor =
        view.kind === "thread" && !!thread?.ancestors.some((candidate) => candidate.id === note.id);

      if (deletedFocused) {
        if (note.parentId) {
          navigateToView({ kind: "thread", spaceId: currentSpaceId, noteId: note.parentId });
          void refreshThread(currentSpaceId, note.parentId);
        } else {
          navigateToView({ kind: "root", spaceId: currentSpaceId });
          void refreshRoots(currentSpaceId, debouncedQuery, selectedTags);
        }
        return;
      }

      if (deletedAncestor) {
        navigateToView({ kind: "root", spaceId: currentSpaceId });
        void refreshRoots(currentSpaceId, debouncedQuery, selectedTags);
        return;
      }

      if (view.kind === "root") {
        void refreshRoots(currentSpaceId, debouncedQuery, selectedTags);
      } else {
        void refreshThread(currentSpaceId, view.noteId);
      }
    },
    [
      view,
      thread,
      debouncedQuery,
      navigateToView,
      refreshRoots,
      refreshThread,
      refreshTags,
      selectedTags,
      currentSpaceId,
    ],
  );

  const handleSelectSpace = useCallback(
    (spaceId: string) => {
      setQuery("");
      setSelectedTags([]);
      setDateRange(null);
      if (view.kind === "thread") {
        navigateToView({ kind: "root", spaceId });
      } else {
        navigateToView({ kind: "root", spaceId });
      }
    },
    [view.kind, navigateToView],
  );

  const closeSpaceModal = useCallback(() => {
    if (spaceModalBusy) return;
    setSpaceModal(null);
    setSpaceNameDraft("");
    setSpaceModalError(null);
  }, [spaceModalBusy]);

  const handleCreateSpace = useCallback(() => {
    setSpaceModal({ kind: "new" });
    setSpaceNameDraft("");
    setSpaceModalError(null);
  }, []);

  const handleRenameSpace = useCallback(
    (targetSpaceId: string) => {
      const current = spaces.find((space) => space.id === targetSpaceId);
      setSpaceModal({ kind: "rename", spaceId: targetSpaceId });
      setSpaceNameDraft(current?.name ?? "");
      setSpaceModalError(null);
    },
    [spaces],
  );

  const handleDeleteSpace = useCallback((targetSpaceId: string) => {
    setSpaceModal({ kind: "delete", spaceId: targetSpaceId });
    setSpaceModalError(null);
  }, []);

  const submitSpaceModal = useCallback(async () => {
    if (!spaceModal) return;
    setSpaceModalBusy(true);
    setSpaceModalError(null);
    try {
      if (spaceModal.kind === "new") {
        const name = spaceNameDraft.trim();
        if (!name) {
          setSpaceModalError("Space name cannot be empty");
          return;
        }
        const created = await api.createSpace(name);
        setError(null);
        await refreshSpaces();
        navigateToView({ kind: "root", spaceId: created.id });
      } else if (spaceModal.kind === "rename") {
        const name = spaceNameDraft.trim();
        if (!name) {
          setSpaceModalError("Space name cannot be empty");
          return;
        }
        await api.updateSpace(spaceModal.spaceId, name);
        setError(null);
        await refreshSpaces();
      } else {
        await api.deleteSpace(spaceModal.spaceId);
        setError(null);
        const refreshed = await api.listSpaces();
        setSpaces(refreshed);
        const stillHasCurrent =
          !!currentSpaceId && refreshed.some((space) => space.id === currentSpaceId);
        if (!stillHasCurrent && refreshed[0]?.id) {
          navigateToView({ kind: "root", spaceId: refreshed[0].id });
        }
      }
      setSpaceModal(null);
      setSpaceNameDraft("");
      setSpaceModalError(null);
    } catch (err) {
      setSpaceModalError(err instanceof Error ? err.message : "Space action failed");
    } finally {
      setSpaceModalBusy(false);
    }
  }, [spaceModal, spaceNameDraft, currentSpaceId, navigateToView, refreshSpaces]);

  const modalTargetSpace =
    spaceModal && spaceModal.kind !== "new"
      ? spaces.find((space) => space.id === spaceModal.spaceId) ?? null
      : null;

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

  const currentThreadId = view.kind === "thread" ? view.noteId : null;

  if (auth.status === "loading") {
    return (
      <div className="app">
        <main className="main">
          <div className="loading">Loading…</div>
        </main>
      </div>
    );
  }
  if (auth.status === "unauthenticated") {
    return <LoginScreen />;
  }

  if (!spacesLoaded) {
    return (
      <div className="app">
        <main className="main">
          <div className="loading">Loading spaces…</div>
        </main>
      </div>
    );
  }

  if (spaces.length === 0) {
    return (
      <WelcomeScreen
        onCreated={(space) => {
          setSpaces([space]);
          navigateToView({ kind: "root", spaceId: space.id });
        }}
      />
    );
  }

  return (
    <div className="app">
      <Sidebar
        spaces={spaces}
        activeSpaceId={currentSpaceId}
        onSelectSpace={handleSelectSpace}
        onCreateSpace={handleCreateSpace}
        onRenameSpace={handleRenameSpace}
        onDeleteSpace={handleDeleteSpace}
        items={sidebarThreads}
        mode={sidebarMode}
        currentThreadId={currentThreadId}
        query={query}
        onQueryChange={(q) => {
          setQuery(q);
          if (currentSpaceId) navigateToView({ kind: "root", spaceId: currentSpaceId });
        }}
        selectedTags={selectedTags}
        onTagClick={(t) => {
          setSelectedTags((prev) =>
            prev.includes(t) ? prev.filter((tag) => tag !== t) : [...prev, t],
          );
          if (currentSpaceId) navigateToView({ kind: "root", spaceId: currentSpaceId });
        }}
        tags={spaceTags}
        onSelect={handleOpenThread}
        dateRange={dateRange}
        onDateRangeChange={(r) => {
          setDateRange(r);
          if (currentSpaceId) navigateToView({ kind: "root", spaceId: currentSpaceId });
        }}
        onNew={() => {
          if (currentSpaceId) navigateToView({ kind: "root", spaceId: currentSpaceId });
          window.setTimeout(() => {
            document
              .querySelector<HTMLTextAreaElement>(".composer-input")
              ?.focus();
          }, 0);
        }}
      />

      <main
        className={`main ${view.kind === "root" && isHeaderCompact ? "is-header-compact" : ""} ${view.kind === "thread" && isThreadHeaderCompact ? "is-thread-header-compact" : ""}`}
      >
        <header className="topbar">
          <Breadcrumb
            view={view}
            currentSpaceName={currentSpaceName}
            thread={thread}
            query={query}
            selectedTags={selectedTags}
            onClearFilters={() => {
              setQuery("");
              setSelectedTags([]);
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
            {/* {auth.status === "authenticated" && auth.user.avatarUrl && (
              <img
                src={auth.user.avatarUrl}
                alt={auth.user.displayName ?? auth.user.email}
                className="topbar-avatar"
                title={auth.user.displayName ?? auth.user.email}
              />
            )} */}
            <button
              type="button"
              className="icon-btn topbar-logout"
              onClick={() => void handleLogout()}
              title="Sign out"
              aria-label="Sign out"
            >
              <Icons.SignOut />
            </button>
          </div>
        </header>

        <div className="canvas">
          {view.kind === "root" ? (
            <RootView
              activeSpaceId={currentSpaceId ?? ""}
              availableTags={spaceTags.map((tag) => tag.name)}
              roots={roots}
              loading={loading}
              error={error}
              query={query}
              selectedTags={selectedTags}
              headerCompact={isHeaderCompact}
              onCreated={handleCreated}
              onUpdated={handleUpdated}
              onDeleted={handleDeleted}
              onOpenThread={handleOpenThread}
              activeReplyComposerId={activeReplyComposerId}
              onReplyComposerChange={setActiveReplyComposerId}
            />
          ) : (
            <ThreadPage
              thread={thread}
              availableTags={spaceTags.map((tag) => tag.name)}
              loading={loading}
              error={error}
              threadHeaderCompact={isThreadHeaderCompact}
              onGoUpLevel={handleGoUpLevel}
              onCreated={handleCreated}
              onUpdated={handleUpdated}
              onDeleted={handleDeleted}
              onOpenThread={handleOpenThread}
              activeReplyComposerId={activeReplyComposerId}
              onReplyComposerChange={setActiveReplyComposerId}
            />
          )}
        </div>
      </main>
      {spaceModal && (
        <div
          className="dialog-backdrop"
          role="presentation"
          onClick={() => closeSpaceModal()}
        >
          <section
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="space-action-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="space-action-dialog-title" className="dialog-title">
              {spaceModal.kind === "new"
                ? "Create space"
                : spaceModal.kind === "rename"
                  ? "Rename space"
                  : "Delete space?"}
            </h3>
            {spaceModal.kind === "delete" ? (
              <p className="dialog-body">
                This will delete "{modalTargetSpace?.name ?? "this space"}" and all threads in it.
              </p>
            ) : (
              <div className="dialog-form">
                <label className="dialog-label" htmlFor="space-name-input">
                  Space name
                </label>
                <input
                  id="space-name-input"
                  className="dialog-input"
                  value={spaceNameDraft}
                  onChange={(e) => setSpaceNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submitSpaceModal();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      closeSpaceModal();
                    }
                  }}
                  disabled={spaceModalBusy}
                  autoFocus
                />
              </div>
            )}
            {spaceModalError && <p className="composer-error">{spaceModalError}</p>}
            <div className="dialog-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={closeSpaceModal}
                disabled={spaceModalBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`btn ${spaceModal.kind === "delete" ? "btn-danger" : "btn-primary"}`}
                onClick={() => void submitSpaceModal()}
                disabled={spaceModalBusy}
              >
                {spaceModalBusy
                  ? "Saving…"
                  : spaceModal.kind === "new"
                    ? "Create"
                    : spaceModal.kind === "rename"
                      ? "Save"
                      : "Delete"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
