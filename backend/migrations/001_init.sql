-- 001_init.sql — initial schema for the Warehouse Receiving System
-- Business rule references (BR-xx) point to docs/prd.md.

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      text        NOT NULL,
  full_name     text        NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 200),
  password_hash text        NOT NULL,
  role          text        NOT NULL CHECK (role IN ('OPERATOR', 'SUPERVISOR')),
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_username_format CHECK (username = lower(username) AND length(username) BETWEEN 3 AND 50),
  CONSTRAINT users_username_key UNIQUE (username)
);

-- ---------------------------------------------------------------------------
-- products (BR-01, BR-02)
-- ---------------------------------------------------------------------------
CREATE TABLE products (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku         text        NOT NULL,
  name        text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description text        CHECK (description IS NULL OR length(description) <= 1000),
  is_active   boolean     NOT NULL DEFAULT true,
  created_by  integer     NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_sku_format CHECK (sku ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  CONSTRAINT products_sku_key UNIQUE (sku)
);
CREATE INDEX products_name_idx ON products (lower(name));

-- ---------------------------------------------------------------------------
-- inventory: current stock, one row per product (BR-14)
-- ---------------------------------------------------------------------------
CREATE TABLE inventory (
  product_id       integer     PRIMARY KEY REFERENCES products (id),
  quantity_on_hand bigint      NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- receiving documents (BR-04, BR-12, BR-15)
-- ---------------------------------------------------------------------------
CREATE SEQUENCE receiving_document_number_seq;

CREATE TABLE receiving_documents (
  id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_number  text        NOT NULL
                   DEFAULT ('RCV-' || lpad(nextval('receiving_document_number_seq')::text, 6, '0')),
  supplier_name    text        NOT NULL CHECK (length(btrim(supplier_name)) BETWEEN 1 AND 200),
  reference_number text        CHECK (reference_number IS NULL OR length(reference_number) <= 100),
  expected_date    date,
  notes            text        CHECK (notes IS NULL OR length(notes) <= 1000),
  status           text        NOT NULL DEFAULT 'OPEN'
                   CHECK (status IN ('OPEN', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'COMPLETED', 'CANCELLED')),
  created_by       integer     NOT NULL REFERENCES users (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_by     integer     REFERENCES users (id),
  completed_at     timestamptz,
  cancelled_by     integer     REFERENCES users (id),
  cancelled_at     timestamptz,
  CONSTRAINT receiving_documents_number_key UNIQUE (document_number),
  -- completion / cancellation metadata must match the status
  CONSTRAINT receiving_documents_completed_meta
    CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL AND completed_by IS NOT NULL)),
  CONSTRAINT receiving_documents_cancelled_meta
    CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL))
);
CREATE INDEX receiving_documents_status_idx  ON receiving_documents (status);
CREATE INDEX receiving_documents_created_idx ON receiving_documents (created_at DESC, id DESC);

-- ---------------------------------------------------------------------------
-- receiving items (BR-04, BR-05, BR-06)
-- received_quantity can never exceed expected_quantity, even if application code is wrong.
-- ---------------------------------------------------------------------------
CREATE TABLE receiving_items (
  id                integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id       integer NOT NULL REFERENCES receiving_documents (id),
  product_id        integer NOT NULL REFERENCES products (id),
  expected_quantity integer NOT NULL CHECK (expected_quantity BETWEEN 1 AND 1000000),
  received_quantity integer NOT NULL DEFAULT 0,
  CONSTRAINT receiving_items_received_within_expected
    CHECK (received_quantity >= 0 AND received_quantity <= expected_quantity),
  CONSTRAINT receiving_items_document_product_key UNIQUE (document_id, product_id)
);
CREATE INDEX receiving_items_product_idx ON receiving_items (product_id);

-- ---------------------------------------------------------------------------
-- receipts: one row per successful receiving submission (BR-08, BR-13)
-- ---------------------------------------------------------------------------
CREATE TABLE receipts (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id     integer     NOT NULL REFERENCES receiving_documents (id),
  received_by     integer     NOT NULL REFERENCES users (id),
  idempotency_key text        CHECK (idempotency_key IS NULL OR length(idempotency_key) BETWEEN 1 AND 128),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipts_idempotency_key_key UNIQUE (idempotency_key)
);
CREATE INDEX receipts_document_idx ON receipts (document_id, id);

-- ---------------------------------------------------------------------------
-- inventory_transactions: append-only stock ledger (BR-09, BR-14)
-- ---------------------------------------------------------------------------
CREATE TABLE inventory_transactions (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id        integer     NOT NULL REFERENCES products (id),
  type              text        NOT NULL CHECK (type IN ('RECEIPT')),
  quantity_change   integer     NOT NULL CHECK (quantity_change <> 0),
  balance_after     bigint      NOT NULL CHECK (balance_after >= 0),
  receipt_id        integer     NOT NULL REFERENCES receipts (id),
  receiving_item_id integer     NOT NULL REFERENCES receiving_items (id),
  created_by        integer     NOT NULL REFERENCES users (id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_transactions_product_idx ON inventory_transactions (product_id, id DESC);
CREATE INDEX inventory_transactions_created_idx ON inventory_transactions (id DESC);
CREATE INDEX inventory_transactions_receipt_idx ON inventory_transactions (receipt_id);

-- The ledger is append-only (NFR-9 / BR-14).
CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'inventory_transactions is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_transactions_append_only
  BEFORE UPDATE OR DELETE ON inventory_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TRIGGER inventory_transactions_no_truncate
  BEFORE TRUNCATE ON inventory_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation();
