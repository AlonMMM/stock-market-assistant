import { useEffect, useState } from "react";
import type { Watchlist } from "../../../packages/market-data/src/watchlists.js";
import { readJson } from "./api.js";
import { parseSymbols } from "./backtest-model.js";

// Named watchlists (user 2026-10-17): a switcher above the table and an editor
// for the chosen list. "All" is the engine list and is edited under Manage
// engine tickers. The chosen list is remembered per browser.

const chosenKey = "sma.watchlist.chosen.v1";
const listsKey = "sma.watchlists.v1";
// Kept while the page is open, like the board, and across visits in this
// browser: the lists show at once and are read again behind them.
let keptLists: Watchlist[] | null = (() => {
  try {
    const raw = localStorage.getItem(listsKey);
    return raw ? (JSON.parse(raw) as Watchlist[]) : null;
  } catch {
    return null;
  }
})();

function readChosen(): string {
  try {
    return localStorage.getItem(chosenKey) || "all";
  } catch {
    return "all";
  }
}

async function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  return readJson(
    await fetch(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(20000),
    }),
  );
}

export function useWatchlists() {
  const [lists, setLists] = useState<Watchlist[] | null>(keptLists);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosenState] = useState(readChosen);
  const keep = (next: Watchlist[]) => {
    keptLists = next;
    setLists(next);
    try {
      localStorage.setItem(listsKey, JSON.stringify(next));
    } catch {
      // Kept for this visit only.
    }
  };
  useEffect(() => {
    let active = true;
    send("GET", "/api/watchlists")
      .then((body) => {
        if (active) keep((body as { lists: Watchlist[] }).lists);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  const choose = (id: string) => {
    setChosenState(id);
    try {
      localStorage.setItem(chosenKey, id);
    } catch {
      // Without storage the choice lasts until the page is closed.
    }
  };
  // "All" is no longer a list to pick (user 2026-10-19): every list's
  // symbols join that pool. The first list stands in for one deleted
  // elsewhere; "All" only while there is no list of one's own.
  const own = (lists ?? []).filter((l) => !l.builtIn);
  const current =
    own.find((l) => l.id === chosen) ??
    own[0] ??
    lists?.find((l) => l.id === "all") ??
    null;
  const replace = (list: Watchlist) =>
    keep((lists ?? []).map((l) => (l.id === list.id ? list : l)));
  return {
    lists,
    error,
    current,
    chosenId: current?.id ?? chosen,
    own,
    choose,
    async create(name: string) {
      const list = (await send("POST", "/api/watchlists", {
        name,
      })) as Watchlist;
      keep([...(lists ?? []), list]);
      choose(list.id);
      return list;
    },
    async change(id: string, body: Record<string, unknown>) {
      const list = (await send(
        "PATCH",
        `/api/watchlists/${id}`,
        body,
      )) as Watchlist;
      replace(list);
      return list;
    },
    async remove(id: string) {
      await send("DELETE", `/api/watchlists/${id}`);
      const next = (lists ?? []).filter((l) => l.id !== id);
      keep(next);
      choose(next.find((l) => !l.builtIn)?.id ?? "all");
    },
  };
}

export type Watchlists = ReturnType<typeof useWatchlists>;

/**
 * One chip per list, a way to start a new one, and "Edit list" for the chosen
 * one (user 2026-10-26: the editor at the foot of the page was hard to find).
 */
export function WatchlistSwitcher({
  w,
  editing = false,
  onEdit,
}: {
  w: Watchlists;
  editing?: boolean;
  onEdit?: () => void;
}) {
  const editable = Boolean(onEdit && w.current && !w.current.builtIn);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!w.lists)
    return w.error ? (
      <p className="notice error" role="alert">
        Watchlists unavailable: {w.error}
      </p>
    ) : null;
  return (
    <div className="wl-lists">
      <div className="wl-chips-row">
        <div className="wl-chips" role="group" aria-label="Watchlist">
          {w.own.map((l) => (
            <button
              type="button"
              key={l.id}
              aria-pressed={w.chosenId === l.id}
              onClick={() => w.choose(l.id)}
            >
              {l.name} <span className="count num">{l.tickers.length}</span>
            </button>
          ))}
          {!naming && (
            <button
              type="button"
              className="wl-new"
              onClick={() => {
                setNaming(true);
                setMessage("");
              }}
            >
              + New list
            </button>
          )}
        </div>
        {editable && (
          <button
            type="button"
            className="wl-edit"
            aria-pressed={editing}
            aria-label={
              editing ? "Close the list editor" : `Edit ${w.current!.name}`
            }
            onClick={onEdit}
          >
            {editing ? "Done" : "Edit list"}
          </button>
        )}
      </div>
      {naming && (
        <form
          className="wl-name-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || !name.trim()) return;
            setBusy(true);
            w.create(name)
              .then(() => {
                setNaming(false);
                setName("");
                setMessage("");
              })
              .catch((err: unknown) => setMessage((err as Error).message))
              .finally(() => setBusy(false));
          }}
        >
          <input
            autoFocus
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            placeholder="List name"
            aria-label="New list name"
            disabled={busy}
          />
          <button
            type="submit"
            className="action primary"
            disabled={busy || !name.trim()}
          >
            {busy ? "Creating…" : "Create"}
          </button>
          <button
            type="button"
            className="action"
            onClick={() => {
              setNaming(false);
              setName("");
              setMessage("");
            }}
          >
            Cancel
          </button>
        </form>
      )}
      {message && (
        <p className="notice error" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}

/** Add and remove symbols of the chosen list, rename it or delete it; shown under the list chips. */
export function WatchlistEditor({
  w,
  onChanged,
}: {
  w: Watchlists;
  onChanged: () => void;
}) {
  const list = w.current;
  const [input, setInput] = useState("");
  const [rename, setRename] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    setRename(list?.name ?? "");
    setConfirmDelete(false);
    setMessage("");
  }, [list?.id]);
  if (!list || list.builtIn) return null;

  const run = (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage("");
    work()
      .then(() => {
        setMessage(done);
        onChanged();
      })
      .catch((err: unknown) => setMessage((err as Error).message))
      .finally(() => setBusy(false));
  };
  const typed = parseSymbols(input);
  return (
    <section
      className="engine-tickers wl-editor"
      aria-label={`Edit ${list.name}`}
    >
      <h3 className="wl-editor-title">
        Edit “{list.name}”{" "}
        <span className="count num">{list.tickers.length}</span>
      </h3>
      <form
        className="engine-ticker-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          if (typed.invalid.length) {
            setMessage(`Not US symbols: ${typed.invalid.join(", ")}.`);
            return;
          }
          const add = typed.valid.filter((t) => !list.tickers.includes(t));
          if (!add.length) {
            setMessage(
              typed.valid.length
                ? "These tickers are already in the list."
                : "Enter at least one ticker.",
            );
            return;
          }
          run(
            async () => {
              await w.change(list.id, { add });
              setInput("");
            },
            `Added ${add.join(", ")}.`,
          );
        }}
      >
        <label className="symbol-search">
          <span>Add tickers</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="AAPL, AMD, TSM"
            disabled={busy}
          />
        </label>
        <button
          type="submit"
          className="action"
          disabled={busy || !input.trim()}
        >
          {busy ? "Saving…" : "Add to list"}
        </button>
      </form>
      <p className="preview">
        Every ticker on a list is also watched for volume alerts.
      </p>
      <div className="chips" aria-label={`${list.name} tickers`}>
        {list.tickers.map((t) => (
          <button
            key={t}
            type="button"
            className="chip"
            aria-label={`Remove ${t} from ${list.name}`}
            disabled={busy}
            onClick={() =>
              run(() => w.change(list.id, { remove: [t] }), `Removed ${t}.`)
            }
          >
            {t} <span aria-hidden="true">×</span>
          </button>
        ))}
      </div>
      <form
        className="engine-ticker-add"
        onSubmit={(e) => {
          e.preventDefault();
          const name = rename.trim();
          if (busy || !name || name === list.name) return;
          run(() => w.change(list.id, { name }), "Renamed.");
        }}
      >
        <label className="symbol-search">
          <span>Name</span>
          <input
            value={rename}
            maxLength={40}
            onChange={(e) => setRename(e.target.value)}
            disabled={busy}
          />
        </label>
        <button
          type="submit"
          className="action"
          disabled={busy || !rename.trim() || rename.trim() === list.name}
        >
          Rename
        </button>
        {confirmDelete ? (
          <>
            <button
              type="button"
              className="action danger"
              disabled={busy}
              onClick={() => run(() => w.remove(list.id), "List deleted.")}
            >
              Delete “{list.name}”
            </button>
            <button
              type="button"
              className="action"
              onClick={() => setConfirmDelete(false)}
            >
              Keep it
            </button>
          </>
        ) : (
          <button
            type="button"
            className="action"
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            Delete list…
          </button>
        )}
      </form>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

/** "+ Add ticker" at the top of the chosen list (user 2026-10-19). */
export function AddTicker({
  w,
  onAdded,
}: {
  w: Watchlists;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const list = w.current;
  if (!list || list.builtIn) return null;
  if (!open)
    return (
      <button
        type="button"
        className="wl-add"
        onClick={() => {
          setOpen(true);
          setMessage("");
        }}
      >
        + Add ticker
      </button>
    );
  const typed = parseSymbols(input);
  return (
    <form
      className="wl-add-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (busy) return;
        if (typed.invalid.length) {
          setMessage(`Not US symbols: ${typed.invalid.join(", ")}.`);
          return;
        }
        const add = typed.valid.filter((t) => !list.tickers.includes(t));
        if (!add.length) {
          setMessage(
            typed.valid.length ? "Already in the list." : "Type a ticker.",
          );
          return;
        }
        setBusy(true);
        setMessage("");
        w.change(list.id, { add })
          .then(() => {
            setInput("");
            setOpen(false);
            onAdded();
          })
          .catch((err: unknown) => setMessage((err as Error).message))
          .finally(() => setBusy(false));
      }}
    >
      <input
        autoFocus
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="NVDA, AMD"
        aria-label={`Add tickers to ${list.name}`}
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
      />
      <button
        type="submit"
        className="action primary"
        disabled={busy || !input.trim()}
      >
        {busy ? "Adding…" : `Add to ${list.name}`}
      </button>
      <button
        type="button"
        className="action"
        onClick={() => {
          setOpen(false);
          setInput("");
          setMessage("");
        }}
      >
        Cancel
      </button>
      {message && (
        <p className="notice error" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}
