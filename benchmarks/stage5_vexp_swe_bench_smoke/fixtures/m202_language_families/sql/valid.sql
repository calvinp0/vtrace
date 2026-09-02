-- Fixture — café 日本語 before declarations
CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE VIEW active_users AS SELECT id, name FROM users WHERE id > 0;

CREATE INDEX users_name_idx ON users (name);

CREATE FUNCTION add_one(x INTEGER) RETURNS INTEGER AS $$ SELECT x + 1 $$ LANGUAGE SQL;

INSERT INTO users (id, name) VALUES (1, 'a');
