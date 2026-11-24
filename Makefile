.PHONY: up down logs build test dev-backend dev-frontend clean

up:            ## Build and start backend (:8000) and frontend (:3000)
	docker compose up -d --build
	@echo "Backend:  http://localhost:8000/health"
	@echo "Frontend: http://localhost:3000"

down:          ## Stop the stack (the SQLite volume is kept)
	docker compose down

logs:          ## Follow logs of both services
	docker compose logs -f

build:         ## Build images without starting them
	docker compose build

test:          ## Run backend tests locally
	cd backend && python -m pytest

dev-backend:   ## Run the API without Docker (needs requirements-dev.txt installed)
	cd backend && DATABASE_URL=sqlite:///./app.db uvicorn app.main:app --reload --port 8000

dev-frontend:  ## Run the React dev server without Docker
	cd frontend && npm install && npm run dev

clean:         ## Stop the stack and delete the SQLite volume
	docker compose down --volumes
