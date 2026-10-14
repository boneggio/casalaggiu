-- Casalaggiù – schema del database D1 "casalaggiu"
CREATE TABLE IF NOT EXISTS richieste (
  id TEXT PRIMARY KEY,
  creata TEXT NOT NULL,
  arrivo TEXT NOT NULL,
  partenza TEXT NOT NULL,
  ospiti INTEGER NOT NULL,
  nome TEXT NOT NULL,
  contatto TEXT NOT NULL,
  messaggio TEXT,
  lingua TEXT,
  stato TEXT NOT NULL DEFAULT 'nuova'   -- nuova | confermata | rifiutata
);
CREATE TABLE IF NOT EXISTS occupato (
  id TEXT PRIMARY KEY,                  -- r_<id richiesta> oppure b_<id> per i blocchi manuali
  arrivo TEXT NOT NULL,
  partenza TEXT NOT NULL,               -- giorno di partenza, escluso
  nota TEXT,
  richiesta_id TEXT
);
CREATE TABLE IF NOT EXISTS impostazioni (
  chiave TEXT PRIMARY KEY,              -- admin_sha, setup_sha, tg_token, tg_chat, tg_last_error
  valore TEXT
);
