#!/usr/bin/env python3
"""Postman manual login via Playwright.

Opens Edge for the user to manually log in.
Extracts session cookie and workspace info once logged in.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import re
import sys
import time

# Optional: Add project root to sys.path if needed
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

POSTMAN_LOGIN_URL = "https://identity.getpostman.com/login"
HANDSHAKE_TOKEN_URL = "https://ra.gw.postman.co/v1/handshake/token?agent=cloud"

def log(step: str, msg: str, level: str = "info"):
    entry = {"step": step, "msg": msg, "level": level, "ts": time.time()}
    sys.stderr.write(json.dumps(entry) + "\n")
    sys.stderr.flush()

def decode_jwt_payload(token: str) -> dict:
    parts = token.split(".")
    if len(parts) < 2:
        return {}
    payload_b64 = parts[1]
    padding = 4 - len(payload_b64) % 4
    if padding != 4:
        payload_b64 += "=" * padding
    try:
        decoded = base64.urlsafe_b64decode(payload_b64)
        return json.loads(decoded)
    except Exception:
        return {}

async def _is_on_postman_workspace(page) -> bool:
    try:
        url = page.url
    except Exception:
        return False
    match = re.search(r'https://([a-z0-9-]+)\.postman\.co', url)
    if not match:
        return False
    subdomain = match.group(1)
    return subdomain not in ("go", "identity", "id", "www")

async def login_postman(email: str, password: str, headless: bool) -> dict:
    from playwright.async_api import async_playwright

    log("init", f"Starting login process (headless={headless})...")
    
    async with async_playwright() as p:
        browser = None
        try:
            log("browser", "Launching Chromium...")
            browser = await p.chromium.launch(
                headless=headless,
                args=[] if headless else ["--start-maximized"]
            )
            context = await browser.new_context()
            page = await context.new_page()

            # Evade basic bot checks (optional but helpful)
            await page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")

            log("navigate", f"Opening {POSTMAN_LOGIN_URL}...")
            await page.goto(POSTMAN_LOGIN_URL, wait_until="domcontentloaded", timeout=60000)

            log("wait", "Waiting for you to log in manually...")
            
            # Poll until URL indicates we are in a workspace
            login_done = False
            workspace_subdomain = "go"
            
            for _ in range(300): # 5 minutes timeout
                try:
                    current_url = page.url
                except Exception:
                    return {"error": "Browser page lost or closed"}
                
                if await _is_on_postman_workspace(page):
                    match = re.search(r'https://([a-z0-9-]+)\.postman\.co', current_url)
                    if match:
                        workspace_subdomain = match.group(1)
                    login_done = True
                    break
                
                await asyncio.sleep(1)

            if not login_done:
                log("error", "Timeout waiting for manual login (5 mins max).", "error")
                return {"error": "Manual login timed out"}

            log("redirect", f"Postman workspace detected: {page.url}")
            log("redirect", f"Subdomain: {workspace_subdomain}")

            log("cookie", "Extracting postman.sid...")
            cookies = await context.cookies()
            postman_sid = None
            for cookie in cookies:
                if cookie.get("name") == "postman.sid":
                    domain = cookie.get("domain", "")
                    if ".postman.co" in domain or domain == "postman.co":
                        postman_sid = cookie.get("value")
                        break
            if not postman_sid:
                for cookie in cookies:
                    if cookie.get("name") == "postman.sid" and cookie.get("value"):
                        postman_sid = cookie.get("value")
                        break

            if not postman_sid:
                log("cookie", "FAILED: postman.sid not found", "error")
                return {"error": "postman.sid cookie not found"}

            log("cookie", "postman.sid extracted successfully")

            log("token", "Fetching handshake token...")
            user_id = ""
            workspace_id = ""
            try:
                handshake = await page.evaluate(
                    f"""async () => {{
                        const resp = await fetch('{HANDSHAKE_TOKEN_URL}', {{credentials: 'include'}});
                        return await resp.json();
                    }}"""
                )
                if handshake and handshake.get("token"):
                    jwt_payload = decode_jwt_payload(handshake["token"])
                    user_id = str(jwt_payload.get("userId", ""))
                    workspace_id = str(jwt_payload.get("teamId", ""))
                    log("token", f"userId={user_id}, teamId={workspace_id}")
            except Exception as e:
                log("token", f"Handshake failed: {e}", "warn")

            if not user_id or not workspace_id:
                log("token", "Fallback to god.postman.co...")
                try:
                    user_info = await page.evaluate(
                        """async () => {
                            const resp = await fetch('https://god.postman.co/api/users/me', {credentials: 'include'});
                            return await resp.json();
                        }"""
                    )
                    if user_info:
                        user_id = str(user_info.get("id", user_id))
                        orgs = user_info.get("user_organizations", {}).get("organizations", [])
                        if orgs:
                            workspace_id = str(orgs[0].get("id", workspace_id))
                        log("token", f"Fallback: userId={user_id}, workspace_id={workspace_id}")
                except Exception as e:
                    log("token", f"Fallback failed: {e}", "warn")

            if not user_id:
                user_id = "unknown"
            if not workspace_id:
                workspace_id = "unknown"

            log("done", f"user_id={user_id} workspace_id={workspace_id} subdomain={workspace_subdomain}")

            return {
                "postman_sid": postman_sid,
                "user_id": user_id,
                "workspace_id": workspace_id,
                "workspace_subdomain": workspace_subdomain,
            }

        except Exception as exc:
            log("error", f"Unexpected error: {exc}", "error")
            return {"error": f"Login failed: {exc}"}
        finally:
            if browser:
                try:
                    await browser.close()
                except Exception:
                    pass

def main():
    parser = argparse.ArgumentParser(description="Postman login via Playwright")
    parser.add_argument("--email", required=False, help="Email (ignored for manual login)")
    parser.add_argument("--password", required=False, help="Password (ignored for manual login)")
    parser.add_argument("--headless", action="store_true", default=False)
    args, unknown = parser.parse_known_args()

    # Disable stdout buffering
    sys.stdout.reconfigure(line_buffering=True)
    
    result = asyncio.run(login_postman(args.email or "", args.password or "", args.headless))
    print(json.dumps(result))

if __name__ == "__main__":
    main()
