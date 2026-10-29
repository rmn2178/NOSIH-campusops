PYTHON := services/nosih-api/.venv/bin/python
PIP := services/nosih-api/.venv/bin/pip

.PHONY: install seed migrate verify dev-api dev-complaint dev-admin test build

install:
	test -x $(PYTHON) || python3.11 -m venv services/nosih-api/.venv
	$(PIP) install -e services/nosih-api
	npm install

seed:
	cd services/nosih-api && .venv/bin/python -m app.seed.seed_campus

migrate:
	cd services/nosih-api && .venv/bin/alembic upgrade head

verify:
	cd services/nosih-api && .venv/bin/python -c "import runpy; runpy.run_path('scripts/verify_phase1.py', run_name='__main__')"

test:
	cd services/nosih-api && .venv/bin/python -m pytest -q

dev-api:
	cd services/nosih-api && .venv/bin/uvicorn app.main:app --reload --port 8000

dev-complaint:
	npm run dev:complaint

dev-admin:
	npm run dev:admin

build:
	npm run build
