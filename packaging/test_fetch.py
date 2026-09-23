"""Regression checks for authenticated, checksum-verified release downloads."""
import hashlib
import io
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

import fetch


class DownloadTests(unittest.TestCase):
    def test_token_only_reaches_github_api_and_is_not_redirected(self):
        url = 'https://api.github.com/repos/AppImage/type2-runtime/releases/assets/123'
        with patch.dict(fetch.os.environ, {'GH_TOKEN': 'test-only-token'}, clear=True):
            request = fetch.download_request(url)
            self.assertEqual(request.get_header('Authorization'), 'Bearer test-only-token')
            for destination in ('https://release-assets.githubusercontent.com/file',
                                'https://api.github.com/another-path'):
                redirected = urllib.request.HTTPRedirectHandler().redirect_request(
                    request, None, 302, 'Found', {}, destination)
                self.assertIsNone(redirected.get_header('Authorization'))
            for other in ('https://github.com/file', 'http://api.github.com/file',
                          'https://api.github.com.example.org/file'):
                self.assertIsNone(fetch.download_request(other).get_header('Authorization'))
        with patch.dict(fetch.os.environ, {}, clear=True):
            self.assertIsNone(fetch.download_request(url).get_header('Authorization'))

    def test_transient_rate_limit_recovers(self):
        errors = [
            urllib.error.HTTPError('https://api.github.com/asset', 403, 'rate limit exceeded',
                                   {'X-RateLimit-Remaining': '0', 'Retry-After': '3'}, None),
            urllib.error.HTTPError('https://api.github.com/asset', 503, 'Unavailable', {}, None),
            io.BytesIO(b'verified asset'),
        ]
        with patch.object(fetch.urllib.request, 'urlopen', side_effect=errors) as opener, \
                patch.object(fetch.time, 'sleep') as sleep:
            self.assertEqual(fetch.download('https://api.github.com/asset', 'runtime'), b'verified asset')
            self.assertEqual(opener.call_count, 3)
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [3, 4])

    def test_retries_are_bounded_and_permanent_errors_fail_immediately(self):
        for error, attempts in (
            (urllib.error.URLError('connection reset'), 5),
            (urllib.error.HTTPError('https://example.org/file', 404, 'Not Found', {}, None), 1),
            (urllib.error.HTTPError('https://example.org/file', 403, 'Forbidden', {}, None), 1),
        ):
            with self.subTest(error=error), \
                    patch.object(fetch.urllib.request, 'urlopen', side_effect=error) as opener, \
                    patch.object(fetch.time, 'sleep') as sleep:
                with self.assertRaises(urllib.error.URLError):
                    fetch.download('https://example.org/file', 'runtime')
                self.assertEqual(opener.call_count, attempts)
                self.assertEqual(sleep.call_count, attempts - 1)

    def test_corrupt_cache_is_replaced_only_with_verified_bytes(self):
        data = b'verified asset'
        digest = hashlib.sha256(data).hexdigest()
        spec = {'runtime': {'url': 'https://example.org/file', 'sha256': digest}}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(fetch, 'CACHE', pathlib.Path(directory)), \
                patch.object(fetch, 'LOCK', spec), \
                patch.object(fetch, 'download') as download:
            path = pathlib.Path(directory) / ('runtime-' + digest[:16])
            path.write_bytes(b'corrupt cache')
            download.return_value = b'wrong asset'
            with self.assertRaisesRegex(RuntimeError, 'SHA-256 mismatch'):
                fetch.fetch('runtime')
            self.assertEqual(path.read_bytes(), b'corrupt cache')
            download.return_value = data
            self.assertEqual(fetch.fetch('runtime').read_bytes(), data)
            download.reset_mock()
            self.assertEqual(fetch.fetch('runtime').read_bytes(), data)
            download.assert_not_called()


if __name__ == '__main__':
    unittest.main()
