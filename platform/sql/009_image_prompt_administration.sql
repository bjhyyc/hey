-- Administrator-owned Seedream awake/sleep prompt lifecycle.
-- No prompt template or prompt text is seeded by this migration.

ALTER TABLE image_prompt_version
  ADD CONSTRAINT image_prompt_version_id_template_unique UNIQUE (id, template_id);

ALTER TABLE image_prompt_template
  DROP CONSTRAINT image_prompt_template_current_version_fk,
  ADD CONSTRAINT image_prompt_template_current_version_fk
  FOREIGN KEY (current_published_version_id, id)
  REFERENCES image_prompt_version(id, template_id);

CREATE TABLE image_prompt_publication_event (
  id UUID PRIMARY KEY,
  template_id UUID NOT NULL REFERENCES image_prompt_template(id),
  from_version_id UUID,
  to_version_id UUID,
  event_type TEXT NOT NULL CHECK (event_type IN ('copy', 'publish', 'rollback')),
  actor_id UUID NOT NULL REFERENCES app_user(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (from_version_id, template_id)
    REFERENCES image_prompt_version(id, template_id),
  FOREIGN KEY (to_version_id, template_id)
    REFERENCES image_prompt_version(id, template_id),
  CHECK (from_version_id IS NOT NULL OR to_version_id IS NOT NULL)
);

CREATE INDEX image_prompt_publication_event_template_created_idx
  ON image_prompt_publication_event (template_id, created_at DESC, id DESC);
