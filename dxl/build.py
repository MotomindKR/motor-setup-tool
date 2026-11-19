"""Build the DXL worker for the current desktop platform into .tools/dxl."""
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig

root = Path(__file__).resolve().parents[1]
output = root / ".tools" / "dxl"
licenses = output / "dxl-worker" / "licenses"
python_license = next(candidate for candidate in (
    Path(sys.base_prefix) / "LICENSE.txt",
    Path(sysconfig.get_path("stdlib")) / "LICENSE.txt",
) if candidate.is_file())
subprocess.run([
    sys.executable, "-m", "PyInstaller", "--clean", "--noconfirm", "--onedir",
    "--name", "dxl-worker", "--paths", str(root / "dxl"),
    "--distpath", str(output), "--workpath", str(output / "build"),
    "--specpath", str(output / "build"),
    "--add-data", f"{root / 'dxl/dxl_settings/ko.json'}:dxl_settings",
    "--copy-metadata", "dynamixel-sdk", "--copy-metadata", "pyserial",
    str(root / "dxl" / "dxl_settings" / "worker.py"),
], check=True, cwd=root)
shutil.copytree(root / "dxl" / "licenses", licenses, dirs_exist_ok=True)
shutil.copyfile(python_license, licenses / "python.txt")
