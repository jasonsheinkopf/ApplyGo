import argparse

import uvicorn

from applygo.db import init_db


def main() -> None:
    parser = argparse.ArgumentParser(prog="applygo")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init-db", help="Create local database tables")
    serve = sub.add_parser("serve", help="Run the local web application")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", default=8000, type=int)
    args = parser.parse_args()
    if args.command == "init-db":
        init_db()
        print("ApplyGo database initialized")
    elif args.command == "serve":
        uvicorn.run("applygo.main:app", host=args.host, port=args.port, reload=True)


if __name__ == "__main__":
    main()
