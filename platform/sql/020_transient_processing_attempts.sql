-- Media processing gets three attempts per action. Those attempts are meant for
-- the artefact: a video the processor cannot normalise, or one that fails its
-- endpoint checks. They were also being spent on ffmpeg decode failures under
-- load, which say nothing about the video - one action of a paid order burned
-- all three that way and died, stalling the run at six of seven.
--
-- Transient infrastructure failures are counted here instead and refunded
-- against `attempts`, so a decoder hiccup costs the action nothing until this
-- separate budget is itself exhausted.
ALTER TABLE production_job_execution
  ADD COLUMN transient_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (transient_attempts >= 0 AND transient_attempts <= 32);
