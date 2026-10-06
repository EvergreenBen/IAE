CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE recipes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  servings integer NOT NULL DEFAULT 4,
  thumbnail_url text,
  created_at timestamp NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', title)) STORED
);
CREATE INDEX recipes_search_idx ON recipes USING gin (search);

CREATE TABLE ingredients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  quantity numeric,
  unit text,
  name text NOT NULL
);

CREATE TABLE steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position integer NOT NULL,
  body text NOT NULL,
  timer_seconds integer
);

-- Work queue polled by apps/jobs
CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  run_at timestamp NOT NULL DEFAULT now(),
  done_at timestamp
);
