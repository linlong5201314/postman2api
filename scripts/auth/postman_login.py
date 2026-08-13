#!/usr/bin/env python3
"""Postman login via Playwright.

Fills credentials when supplied, then extracts the authenticated session.
Without credentials it keeps the headed/manual-login fallback for local use.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import re
import sys
import time
from typing import Any

# Optional: Add project root to sys.path if needed
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

POSTMAN_LOGIN_URL = "https://identity.getpostman.com/login"
HANDSHAKE_TOKEN_URL = "https://ra.gw.postman.co/v1/handshake/token?agent=cloud"
HEADLESS_LOGIN_TIMEOUT_SECONDS = 60
MANUAL_LOGIN_TIMEOUT_SECONDS = 300
CAPTCHA_GRACE_SECONDS = 10
CHALLENGE_WAIT_SECONDS = 45
RETRY_CAPTCHA_MARKER = "__retry_captcha__"

STEALTH_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
)

STEALTH_INIT_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
window.chrome = { runtime: {} };
Object.defineProperty(navigator, 'languages', {get: () => ['zh-CN', 'zh', 'en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
"""

USERNAME_SELECTORS = (
    "#username",
    'input[name="username"]',
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[name="email"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="username" i]',
)

PASSWORD_SELECTORS = (
    "#password",
    'input[name="password"]',
    'input[type="password"]',
    'input[autocomplete="current-password"]',
)

SUBMIT_SELECTORS = (
    "#sign-in-btn",
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
)

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

def read_login_input() -> tuple[str, str, bool]:
    if sys.stdin.isatty():
        raw = ""
    else:
        try:
            raw = sys.stdin.read()
        except OSError:
            raw = ""
    try:
        if raw.strip():
            payload = json.loads(raw)
            return (
                str(payload.get("email", "")),
                str(payload.get("password", "")),
                bool(payload.get("headless", False)),
            )
    except (TypeError, ValueError):
        pass
    return (
        os.getenv("POSTMAN_LOGIN_EMAIL", ""),
        os.getenv("POSTMAN_LOGIN_PASSWORD", ""),
        os.getenv("POSTMAN_LOGIN_HEADLESS", "").lower() == "true",
    )

async def _is_challenge_page(page) -> bool:
    try:
        title = (await page.title()).lower()
    except Exception:
        return False
    if "moment" in title or "attention" in title or "challenge" in title:
        return True
    try:
        body = (await page.locator("body").inner_text(timeout=1000)).lower()
    except Exception:
        body = ""
    return any(marker in body for marker in (
        "verify you are human", "security verification", "正在验证", "安全验证", "挑战",
    ))

async def _wait_for_signin_form(page) -> bool:
    deadline = time.monotonic() + CHALLENGE_WAIT_SECONDS
    while time.monotonic() < deadline:
        if await _is_on_postman_workspace(page):
            return True
        for selector in USERNAME_SELECTORS:
            try:
                if await page.locator(selector).first.is_visible(timeout=250):
                    log("challenge", "Sign-in form visible", "info")
                    return True
            except Exception:
                continue
        if not await _is_challenge_page(page):
            # Page settled on something unexpected; let the credential flow report it.
            return True
        await asyncio.sleep(1)
    return False

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

async def _visible_locator(page, selectors: list[str], timeout: int = 3000):
    for selector in selectors:
        locator = page.locator(selector).first
        try:
            await locator.wait_for(state="visible", timeout=timeout)
            return locator
        except Exception:
            continue
    return None

async def _click_email_login(page) -> bool:
    for selector in (
        'button:has-text("Continue with email")',
        'button:has-text("Sign in with email")',
        'button:has-text("Use email")',
        'a:has-text("Continue with email")',
    ):
        locator = page.locator(selector).first
        try:
            await locator.wait_for(state="visible", timeout=1500)
            await locator.click()
            return True
        except Exception:
            continue
    return False

async def _submit_login_step(page) -> bool:
    for selector in SUBMIT_SELECTORS:
        locator = page.locator(selector).first
        try:
            await locator.wait_for(state="visible", timeout=2000)
            await locator.click()
            return True
        except Exception:
            continue
    return False

async def _fill_credentials(page, email: str, password: str) -> str | None:
    if not email or not password:
        return None

    username_input = await _visible_locator(page, list(USERNAME_SELECTORS), timeout=4000)
    if username_input is None:
        await _click_email_login(page)
        username_input = await _visible_locator(page, list(USERNAME_SELECTORS), timeout=4000)
    if username_input is None:
        return "Username/email input was not found; the provider may require manual or OAuth login"

    await username_input.fill(email)
    password_input = await _visible_locator(page, list(PASSWORD_SELECTORS), timeout=1500)
    if password_input is None:
        if not await _submit_login_step(page):
            return "Could not advance from the username step"
        password_input = await _visible_locator(page, list(PASSWORD_SELECTORS), timeout=10000)
    if password_input is None:
        return "Password input was not found; the provider may require OAuth, MFA, or CAPTCHA"

    await password_input.fill(password)
    if not await _submit_login_step(page):
        return "Could not submit the password step"
    log("credentials", "Credentials submitted; waiting for provider redirect")
    return None

async def _visible_text(page, selectors: tuple[str, ...]) -> str:
    for selector in selectors:
        locator = page.locator(selector).first
        try:
            if await locator.is_visible(timeout=250):
                text = (await locator.inner_text(timeout=250)).strip()
                if text:
                    return text
        except Exception:
            continue
    return ""

async def _headless_login_blocker(page, submitted_at: float) -> str | None:
    current_url = page.url.lower()

    error_text = await _visible_text(page, (
        "#input-error-username",
        "#input-error-password",
        '[role="alert"]',
        ".input-validation-error",
    ))
    if error_text and any(marker in error_text.lower() for marker in (
        "invalid", "incorrect", "unable to sign in", "does not match", "not recognized",
    )):
        return "Invalid Postman email/username or password."

    page_text = (await page.locator("body").inner_text(timeout=1000)).lower()

    reset_markers = ("reset your password", "sent you an email to reset", "password reset")
    if any(marker in page_text for marker in reset_markers):
        return (
            "Postman rejected the password and sent a reset email. Update the password "
            "from the email, then add the account again."
        )

    captcha_fail = any(marker in page_text for marker in (
        "unable to verify the captcha", "verify the captcha",
    ))
    if captcha_fail:
        return RETRY_CAPTCHA_MARKER

    mfa_url = any(marker in current_url for marker in ("mfa", "two-factor", "two_factor", "otp"))
    mfa_text = any(marker in page_text for marker in (
        "verification code", "authenticator", "two-factor", "two factor", "two-step", "multi-factor",
    ))
    try:
        mfa_input = await page.locator(
            'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="code" i]'
        ).first.is_visible(timeout=250)
    except Exception:
        mfa_input = False
    if mfa_url or (mfa_input and mfa_text):
        return (
            "Postman requires multi-factor authentication; complete it in a headed browser "
            "or import tokens manually."
        )

    if any(marker in current_url for marker in ("/enterprise/login", "/google/oauth2", "/oauth2/")):
        return (
            "Postman redirected to SSO/OAuth; email/password automation is not supported. "
            "Use the required provider flow or import tokens manually."
        )

    captcha_visible = False
    try:
        captcha_visible = await page.locator(
            'iframe[src*="challenges.cloudflare.com"], iframe[title*="challenge" i]'
        ).first.is_visible(timeout=250)
    except Exception:
        pass
    captcha_text = any(marker in page_text for marker in (
        "verify you are human", "captcha", "security check",
    ))
    turnstile_empty = False
    if "identity.getpostman.com" in current_url and time.monotonic() - submitted_at >= CAPTCHA_GRACE_SECONDS:
        try:
            turnstile = page.locator('input[name="cf-turnstile-response"]').first
            if await turnstile.count() > 0:
                turnstile_empty = not (await turnstile.input_value(timeout=250)).strip()
        except Exception:
            pass
    if captcha_visible or captcha_text or turnstile_empty:
        return (
            "Postman requires CAPTCHA/Turnstile verification; use a headed browser "
            "or import tokens manually."
        )

    return None

async def _launch_browser(p, headless: bool):
    try:
        return await _launch_camoufox(p, headless)
    except Exception as exc:
        log("browser", f"Camoufox unavailable ({exc}); falling back to Chromium", "warn")
        return await _launch_chromium(p, headless)

async def _launch_camoufox(p, headless: bool):
    from camoufox.addons import DefaultAddons
    from camoufox.async_api import AsyncNewBrowser

    kwargs: dict[str, Any] = {
        "humanize": True,
        "os": "windows",
        "block_webrtc": True,
        "addons": [],
        "exclude_addons": [DefaultAddons.UBO],
    }
    if headless:
        # Virtual display (Xvfb) works on Linux; plain headless elsewhere.
        kwargs["headless"] = "virtual" if sys.platform != "win32" else True
    browser = await AsyncNewBrowser(p, **kwargs)
    log("browser", "Launched Camoufox (anti-detection Firefox)")
    return browser

async def _launch_chromium(p, headless: bool):
    launch_args = [
        "--disable-blink-features=AutomationControlled",
        "--no-default-browser-check",
        "--no-first-run",
        "--no-sandbox",
    ]
    if not headless:
        launch_args.append("--start-maximized")
    try:
        browser = await p.chromium.launch(headless=headless, channel="chromium", args=launch_args)
    except Exception:
        log("browser", "Full Chromium unavailable; falling back to bundled build", "warn")
        browser = await p.chromium.launch(headless=headless, args=launch_args)
    log("browser", "Launched Chromium")
    return browser

async def login_postman(email: str, password: str, headless: bool) -> dict:
    from playwright.async_api import async_playwright

    if headless and (not email or not password):
        return {"error": "Headless login requires both a Postman email/username and password."}

    log("init", f"Starting login process (headless={headless})...")
    
    async with async_playwright() as p:
        browser = None
        try:
            browser = await _launch_browser(p, headless)
            is_camoufox = browser.browser_type.name == "firefox"

            context = await browser.new_context(
                viewport={"width": 1366, "height": 768},
                locale="zh-CN",
                timezone_id="Asia/Shanghai",
                **({} if is_camoufox else {"user_agent": STEALTH_UA}),
            )
            page = await context.new_page()

            # Evade basic bot checks for Chromium; Camoufox injects its own fingerprint.
            if not is_camoufox:
                await page.add_init_script(STEALTH_INIT_SCRIPT)

            # Cloudflare challenge + Turnstile can be flaky. Retry the whole
            # navigation/credential flow once before giving up.
            login_done = False
            workspace_subdomain = "go"
            for attempt in range(2):
                log("navigate", f"Opening {POSTMAN_LOGIN_URL} (attempt {attempt + 1})...")
                await page.goto(POSTMAN_LOGIN_URL, wait_until="domcontentloaded", timeout=60000)

                # Cloudflare may present a managed challenge before the sign-in form.
                if not await _wait_for_signin_form(page):
                    if attempt == 0:
                        log("challenge", "Cloudflare challenge did not resolve; retrying", "warn")
                        continue
                    return {
                        "error": (
                            "Postman is showing a Cloudflare challenge that did not resolve. "
                            "Try again later or import tokens manually."
                        )
                    }

                credential_error = await _fill_credentials(page, email, password)
                if credential_error:
                    if headless:
                        log("error", credential_error, "error")
                        return {"error": credential_error}
                    log("credentials", credential_error, "warn")
                    log("wait", "Waiting for you to complete login manually...")
                elif not email or not password:
                    log("wait", "Waiting for you to log in manually...")

                # Poll until the provider reaches a workspace or exposes a terminal login state.
                submitted_at = time.monotonic()
                timeout_seconds = HEADLESS_LOGIN_TIMEOUT_SECONDS if headless else MANUAL_LOGIN_TIMEOUT_SECONDS
                deadline = time.monotonic() + timeout_seconds

                while time.monotonic() < deadline:
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

                    if headless and email and password:
                        blocker = await _headless_login_blocker(page, submitted_at)
                        if blocker:
                            if blocker == RETRY_CAPTCHA_MARKER and attempt == 0:
                                log("captcha", "Turnstile rejected the attempt; retrying once", "warn")
                                break
                            log("error", blocker, "error")
                            return {"error": blocker}

                    await asyncio.sleep(0.5)

                if login_done:
                    break

            if not login_done:
                error = (
                    "Postman login did not reach a workspace within 60 seconds."
                    if headless
                    else "Manual Postman login timed out after 5 minutes."
                )
                log("error", error, "error")
                return {"error": error}

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
    parser.add_argument("--email", required=False, help="Login email (prefer POSTMAN_LOGIN_EMAIL)")
    parser.add_argument("--password", required=False, help="Login password (prefer POSTMAN_LOGIN_PASSWORD)")
    parser.add_argument("--headless", action="store_true", default=False)
    args, unknown = parser.parse_known_args()

    # Disable stdout buffering
    sys.stdout.reconfigure(line_buffering=True)
    
    stdin_email, stdin_password, stdin_headless = read_login_input()
    email = args.email or stdin_email
    password = args.password or stdin_password
    headless = args.headless or stdin_headless
    result = asyncio.run(login_postman(email, password, headless))
    print(json.dumps(result))

if __name__ == "__main__":
    main()
