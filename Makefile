ifeq ($(OS),Windows_NT)
VENV_BIN := Scripts
else
VENV_BIN := bin
endif

PYTHON := .venv/$(VENV_BIN)/python
PIP := .venv/$(VENV_BIN)/pip
ALEMBIC := .venv/$(VENV_BIN)/alembic
UVICORN := .venv/$(VENV_BIN)/uvicorn

.PHONY: install seed migrate verify verify-live verify-demo verify-officer demo-state dev-api dev-complaint dev-admin test build

install:
	test -x services/nosih-api/$(PYTHON) || python -m venv services/nosih-api/.venv
	cd services/nosih-api && $(PIP) install -e ".[test]"
	npm install

seed:
	cd services/nosih-api && $(PYTHON) -m app.seed.seed_campus

migrate:
	cd services/nosih-api && $(ALEMBIC) upgrade head

verify:
	cd services/nosih-api && $(PYTHON) scripts/verify_phase1.py

verify-live:
	cd services/nosih-api && $(PYTHON) scripts/verify_all.py

verify-demo:
	cd services/nosih-api && $(PYTHON) scripts/verify_demo_curation.py

verify-officer:
	cd services/nosih-api && $(PYTHON) scripts/verify_officer_booking.py

demo-state:
	cd services/nosih-api && $(PYTHON) scripts/apply_sql_file.py scripts/f10_curate_demo.sql

test:
	cd services/nosih-api && $(PYTHON) -m pytest -q

dev-api:
	cd services/nosih-api && $(UVICORN) app.main:app --reload --port 8000

dev-complaint:
	npm run dev:complaint

dev-admin:
	npm run dev:admin

build:
	npm run build
