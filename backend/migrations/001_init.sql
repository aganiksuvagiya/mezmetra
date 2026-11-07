-- TableSeva schema. Works on PostgreSQL 14+ (Aiven) and PGlite (local dev/tests).
-- Money is stored in paise (integer). Timestamps are timestamptz (UTC).

CREATE TABLE vendors (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text        NOT NULL,
  email         text        NOT NULL,
  password_hash text        NOT NULL,
  currency      text        NOT NULL DEFAULT 'INR',
  timezone      text        NOT NULL DEFAULT 'Asia/Kolkata',
  tax_percent   numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_percent >= 0 AND tax_percent <= 100),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vendors_email_key ON vendors (lower(email));

CREATE TABLE vendor_payment_settings (
  vendor_id               bigint PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  cash_enabled            boolean     NOT NULL DEFAULT true,
  razorpay_enabled        boolean     NOT NULL DEFAULT false,
  razorpay_key_id         text,
  razorpay_key_secret_enc text,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id   bigint      NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  description text        NOT NULL DEFAULT '',
  is_active   boolean     NOT NULL DEFAULT true,
  sort_order  integer     NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_vendor_name_key ON categories (vendor_id, lower(name));

CREATE TABLE items (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id     bigint      NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  category_id   bigint      NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
  name          text        NOT NULL,
  description   text        NOT NULL DEFAULT '',
  price_paise   integer     NOT NULL CHECK (price_paise >= 0),
  is_active     boolean     NOT NULL DEFAULT true,
  is_featured   boolean     NOT NULL DEFAULT false,
  has_photo     boolean     NOT NULL DEFAULT false,
  photo_version integer     NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX items_vendor_category_idx ON items (vendor_id, category_id);

-- Photos live in their own table so list queries never drag the bytes along.
CREATE TABLE item_photos (
  item_id bigint PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  mime    text  NOT NULL,
  data    bytea NOT NULL
);

CREATE TABLE option_groups (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id      bigint  NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name         text    NOT NULL,
  multi_select boolean NOT NULL DEFAULT false,
  required     boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0
);
CREATE INDEX option_groups_item_idx ON option_groups (item_id);

CREATE TABLE options (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_id    bigint  NOT NULL REFERENCES option_groups(id) ON DELETE CASCADE,
  name        text    NOT NULL,
  price_paise integer NOT NULL DEFAULT 0 CHECK (price_paise >= 0),
  sort_order  integer NOT NULL DEFAULT 0
);
CREATE INDEX options_group_idx ON options (group_id);

CREATE TABLE dining_tables (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id  bigint      NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  number     text        NOT NULL,
  capacity   integer     NOT NULL CHECK (capacity > 0),
  area       text        NOT NULL DEFAULT 'Indoor',
  is_active  boolean     NOT NULL DEFAULT true,
  -- Unguessable token that goes into the QR code (never the numeric id or the vendor email).
  qr_token   text        NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dining_tables_vendor_number_key ON dining_tables (vendor_id, lower(number));

CREATE TABLE orders (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor_id        bigint      NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  table_id         bigint      REFERENCES dining_tables(id) ON DELETE SET NULL,
  table_number     text        NOT NULL,
  -- What customers use to follow/pay for their order; the numeric id is never exposed publicly.
  public_token     uuid        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  idempotency_key  text,
  status           text        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'accepted', 'completed', 'cancelled')),
  payment_status   text        NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid')),
  payment_method   text        CHECK (payment_method IN ('cash', 'razorpay')),
  pay_pref         text        NOT NULL DEFAULT 'counter' CHECK (pay_pref IN ('counter', 'online')),
  subtotal_paise   integer     NOT NULL CHECK (subtotal_paise >= 0),
  tax_paise        integer     NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  total_paise      integer     NOT NULL CHECK (total_paise >= 0),
  note             text        NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  accepted_at      timestamptz,
  completed_at     timestamptz,
  paid_at          timestamptz
);
CREATE UNIQUE INDEX orders_idempotency_key ON orders (table_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX orders_vendor_created_idx ON orders (vendor_id, created_at DESC);
CREATE INDEX orders_vendor_paid_idx ON orders (vendor_id, paid_at) WHERE payment_status = 'paid';

CREATE TABLE order_items (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id         bigint  NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id          bigint  REFERENCES items(id) ON DELETE SET NULL,
  name             text    NOT NULL,
  unit_price_paise integer NOT NULL CHECK (unit_price_paise >= 0),
  quantity         integer NOT NULL CHECK (quantity > 0),
  instructions     text    NOT NULL DEFAULT '',
  options          jsonb   NOT NULL DEFAULT '[]'::jsonb,
  line_total_paise integer NOT NULL CHECK (line_total_paise >= 0)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE payments (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id            bigint      NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider            text        NOT NULL CHECK (provider IN ('cash', 'razorpay')),
  provider_order_id   text,
  provider_payment_id text,
  amount_paise        integer     NOT NULL CHECK (amount_paise >= 0),
  status              text        NOT NULL CHECK (status IN ('created', 'paid', 'failed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  paid_at             timestamptz
);
CREATE UNIQUE INDEX payments_provider_payment_key ON payments (provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX payments_order_idx ON payments (order_id);
