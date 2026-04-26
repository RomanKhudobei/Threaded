# Threaded

A quiet little notebook for writing down thoughts and following them through
infinitely deep threads.

![preview](images/image.png)

The repo holds two pieces:

- **Frontend** — a Vite + React (TypeScript) single-page app that renders the
  white-grey UI, the composer, and the focused thread view.
- **Backend** — an async [FastAPI](https://fastapi.tiangolo.com/) service that
  stores self-referential notes in a SQLite database under `backend/data/`.

## Repository layout

```
.
├── backend/
│   ├── main.py            # FastAPI app + endpoints
│   ├── store.py           # Async SQLite note store (aiosqlite)
│   └── requirements.txt   # Python dependencies
├── src/
│   ├── App.tsx            # Threaded UI
│   ├── App.css            # White-grey styling
│   └── main.tsx           # React entry point
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts         # Proxies /api to the FastAPI server
```

## Prerequisites

- Node.js 18+
- Python 3.10+

## Running the backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --reload --port 8000
```

> Run `uvicorn` from the repo root (one level above `backend/`) so the
> `backend.main:app` import path resolves.

On first request the backend creates `backend/data/threaded.sqlite3` (plus
the WAL/SHM sidecar files SQLite uses), initializes the schema, and enables
WAL mode. Override the location with
`THREADED_DATABASE_PATH=/path/to/threaded.sqlite3`.

### Schema

```sql
CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES notes(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_notes_parent_id_created_at
  ON notes(parent_id, created_at);
```

Child lookups (`list_children`) and primary-key fetches (`get`) hit the
indexes; ancestor walks use a recursive CTE with a depth guard to stay safe
if data ever gets corrupted into a cycle.

### API summary

- `GET /api/notes?parentId=` — list root notes when empty/null, or direct
  children for a parent.
- `GET /api/notes/{id}/thread` — focused note, its children, and a paginated
  ancestor path (newest ancestors plus `hasMoreAncestors` / `totalAncestors`).
- `POST /api/notes` — create a root note (no `parentId`) or a child note.

## Running the frontend

```bash
npm install
npm run dev
```

Vite serves the SPA on http://localhost:5173 and proxies `/api/*` to the
FastAPI dev server on port 8000, so start the backend first.

### Type-checking and production build

```bash
npm run typecheck
npm run build
```

## How threading works

- Every item is a `Note { id, parentId, text, createdAt }`.
- Root notes have `parentId === null`.
- Hovering a card reveals a small curved thread arrow; clicking it opens an
  inline composer for a child note. The inline composer also includes an
  **Expand** button that switches the view to the focused thread for that
  parent.
- Focused thread view shows a clickable, paginated breadcrumb so you can step
  back up the lineage one note at a time.

## To Do
- Refine shortcuts (ctrl+n for new note, arrows up and down to navigate thoughts, enter to go one level deeper, backspace to go one level upper)
- Add tags
- Add date range filter
- Add ability to edit thoughts
- Add ability to delete thoughts (send them into 30-day retention trash)