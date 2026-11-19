"""Build the DXL worker for the current desktop platform into .tools/dxl."""
from pathlib import Path
import shutil
import subprocess
import sys
import sysconfig

root = Path(__file__).resolve().parents[1]
output = root / ".tools" / "dxl"
licenses = output / "licenses"
shutil.copytree(root / "dxl" / "licenses", licenses, dirs_exist_ok=True)
python_license = next(candidate for candidate in (
    Path(sys.base_prefix) / "LICENSE.txt",
    Path(sysconfig.get_path("stdlib")) / "LICENSE.txt",
) if candidate.is_file())
shutil.copyfile(python_license, licenses / "python.txt")
subprocess.run([
    sys.executable, "-m", "PyInstaller", "--clean", "--noconfirm", "--onefile",
    "--name", "dxl-worker", "--paths", str(root / "dxl"),
    "--distpath", str(output), "--workpath", str(output / "build"),
    "--specpath", str(output / "build"),
    "--copy-metadata", "dynamixel-sdk", "--copy-metadata", "pyserial",
    str(root / "dxl" / "dxl_settings" / "worker.py"),
], check=True, cwd=root)
