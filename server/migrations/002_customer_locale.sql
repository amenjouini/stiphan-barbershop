-- The language a customer chose on the website (fr / ar / en); emails to them use it.
ALTER TABLE customers ADD COLUMN locale TEXT;
