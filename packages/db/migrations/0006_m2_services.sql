CREATE FUNCTION caisson_contains_secret_shaped_value(input_value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  key_name TEXT;
  child JSONB;
  string_value TEXT;
  normalized_key TEXT;
BEGIN
  CASE jsonb_typeof(input_value)
    WHEN 'object' THEN
      FOR key_name, child IN SELECT entry.key, entry.value FROM jsonb_each(input_value) AS entry
      LOOP
        normalized_key := regexp_replace(lower(key_name), '[^a-z]', '', 'g');
        IF normalized_key = ANY (ARRAY[
          'password', 'secret', 'token', 'apikey', 'privatekey', 'credential', 'accesskey'
        ]) OR caisson_contains_secret_shaped_value(child) THEN
          RETURN TRUE;
        END IF;
      END LOOP;
    WHEN 'array' THEN
      FOR child IN SELECT element.value FROM jsonb_array_elements(input_value) AS element
      LOOP
        IF caisson_contains_secret_shaped_value(child) THEN
          RETURN TRUE;
        END IF;
      END LOOP;
    WHEN 'string' THEN
      string_value := input_value #>> '{}';
      RETURN string_value ~ 'AKIA[A-Z0-9]{16}'
        OR string_value ~ '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
        OR string_value ~ '[A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+'
        OR string_value ~ 'sk-[A-Za-z0-9]{20,}';
    ELSE
      RETURN FALSE;
  END CASE;
  RETURN FALSE;
END;
$$;

CREATE TABLE services (
  id         UUID PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  adapter    TEXT NOT NULL,
  config     JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT services_config_not_secret_shaped
    CHECK (NOT caisson_contains_secret_shaped_value(config))
);

CREATE TABLE credential_refs (
  id           UUID PRIMARY KEY,
  service_id   UUID NOT NULL REFERENCES services(id),
  role         TEXT NOT NULL,
  backend      TEXT NOT NULL,
  backend_path TEXT NOT NULL,
  rotated_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credential_refs_service_role_uidx UNIQUE (service_id, role),
  CONSTRAINT credential_refs_backend_path_not_secret_shaped
    CHECK (NOT caisson_contains_secret_shaped_value(to_jsonb(backend_path)))
);
