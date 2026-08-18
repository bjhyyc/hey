-- Species was collected by the web home page and then discarded: nothing below
-- the browser knew whether the customer uploaded a cat or a dog, so every run
-- generated against the dog prompt set. Two of the seven prompts name the
-- species outright, including idle, which is both the most-played clip and the
-- identity anchor - so a cat was being anchored as "the same dog".
--
-- Species becomes part of the immutable per-run snapshot: the project records
-- what the customer chose, the run freezes it alongside the model registry, and
-- prompt templates gain a species so each action carries one published prompt
-- per species. Existing rows are dogs, which is what they were generated as.

ALTER TABLE pet_project
  ADD COLUMN species TEXT NOT NULL DEFAULT 'dog',
  ADD CONSTRAINT pet_project_species_check CHECK (species IN ('dog', 'cat'));

ALTER TABLE production_run
  ADD COLUMN species TEXT NOT NULL DEFAULT 'dog',
  ADD CONSTRAINT production_run_species_check CHECK (species IN ('dog', 'cat'));

ALTER TABLE prompt_template
  ADD COLUMN species TEXT NOT NULL DEFAULT 'dog',
  ADD CONSTRAINT prompt_template_species_check CHECK (species IN ('dog', 'cat')),
  DROP CONSTRAINT prompt_template_action_id_key,
  ADD CONSTRAINT prompt_template_action_species_key UNIQUE (action_id, species);
