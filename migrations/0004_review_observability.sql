-- Store the PR diff for post-hoc review quality evaluation
ALTER TABLE reviews ADD COLUMN diff_text TEXT;

-- Track which system prompt version produced this review
ALTER TABLE reviews ADD COLUMN system_prompt_hash TEXT;

-- Split token tracking per turn (replacing combined tokens_used)
ALTER TABLE review_traces ADD COLUMN input_tokens INTEGER;
ALTER TABLE review_traces ADD COLUMN output_tokens INTEGER;

-- Track which agent loop iteration a turn belongs to
ALTER TABLE review_traces ADD COLUMN iteration INTEGER;

-- Store full tool input/result separately (content_json stays for assistant text)
ALTER TABLE review_traces ADD COLUMN tool_input TEXT;
ALTER TABLE review_traces ADD COLUMN tool_result TEXT;
