"""Checks for checksum-verified MuJoCo SDK downloads."""
import hashlib
import io
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import fetch


class DownloadTests(unittest.TestCase):
    def test_transient_errors_recover_after_the_servers_retry_delay(self):
        retry_after = 15
        errors = [
            urllib.error.HTTPError('https://api.github.com/asset', 403, 'rate limit exceeded',
                                   {'X-RateLimit-Remaining': '0', 'Retry-After': str(retry_after)}, None),
            urllib.error.HTTPError('https://api.github.com/asset', 503, 'Unavailable', {}, None),
            io.BytesIO(b'verified asset'),
        ]
        with patch.object(fetch.urllib.request, 'urlopen', side_effect=errors), \
                patch.object(fetch.time, 'sleep') as sleep:
            self.assertEqual(fetch.download('https://api.github.com/asset', 'mujoco'), b'verified asset')
            self.assertGreaterEqual(sleep.call_args_list[0].args[0], retry_after)

    def test_retries_are_bounded_and_permanent_errors_fail_immediately(self):
        for error, transient in (
            (urllib.error.URLError('connection reset'), True),
            (urllib.error.HTTPError('https://example.org/file', 404, 'Not Found', {}, None), False),
            (urllib.error.HTTPError('https://example.org/file', 403, 'Forbidden', {}, None), False),
        ):
            with self.subTest(error=error), \
                    patch.object(fetch.urllib.request, 'urlopen', side_effect=error) as opener, \
                    patch.object(fetch.time, 'sleep'):
                with self.assertRaises(urllib.error.URLError):
                    fetch.download('https://example.org/file', 'mujoco')
                if transient:
                    self.assertGreater(opener.call_count, 1)
                else:
                    opener.assert_called_once()

    def test_corrupt_cache_is_replaced_only_with_verified_bytes(self):
        data = b'verified asset'
        digest = hashlib.sha256(data).hexdigest()
        spec = {'url': 'https://example.org/file', 'sha256': digest}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(fetch, 'download') as download:
            cache = pathlib.Path(directory)
            download.return_value = data
            path = fetch.fetch('mujoco', spec, cache)
            path.write_bytes(b'corrupt cache')
            download.return_value = b'wrong asset'
            with self.assertRaisesRegex(RuntimeError, 'SHA-256 mismatch'):
                fetch.fetch('mujoco', spec, cache)
            download.return_value = data
            self.assertEqual(fetch.fetch('mujoco', spec, cache).read_bytes(), data)
            download.reset_mock()
            self.assertEqual(fetch.fetch('mujoco', spec, cache).read_bytes(), data)
            download.assert_not_called()


if __name__ == '__main__':
    unittest.main()
