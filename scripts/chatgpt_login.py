#!/usr/bin/env python3
"""Sign in with ChatGPT and write the token store OPEN_SWE_OPENAI_OAUTH_TOKEN_FILE names."""

import sys
from pathlib import Path

from langchain_openai.chatgpt_oauth import login_chatgpt

if len(sys.argv) != 2 or not sys.argv[1]:
    sys.exit("usage: make chatgpt-login (reads OPEN_SWE_OPENAI_OAUTH_TOKEN_FILE from .env)")

store = Path(sys.argv[1]).expanduser()
login_chatgpt(store_path=store)
print(f"Signed in; tokens stored at {store}")
