"""Build and verify the Firefox upload archive, including every icon format."""
import argparse
import json
import re
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_FILES = (
    'manifest.json', 'i18n.js', 'background.js', 'sync.js', 'options.html',
    'options.js', 'sidebar.html', 'sidebar.js', 'emoji-catalog.json',
    'sync-breath.css', 'sync-breath.js', 'sync-progress.css', 'sync-progress.js',
)


def release_files():
    files = [ROOT / name for name in RUNTIME_FILES]
    # Resource formats must not be restricted to PNG: the counts button uses SVG.
    files += sorted(file for file in (ROOT / 'icons').rglob('*') if file.is_file())
    files += sorted((ROOT / '_locales').glob('*/messages.json'))
    for file in files:
        if not file.is_file():
            raise ValueError(f'Missing release file: {file}')
    return {file.relative_to(ROOT).as_posix(): file for file in files}


def check_resources(files):
    references = {'icons/tab-counts-64.svg'}
    manifest = json.loads(files['manifest.json'].read_text(encoding='utf-8-sig'))
    references.update(manifest['background']['scripts'])
    references.add(manifest['options_ui']['page'])
    references.add(manifest['sidebar_action']['default_panel'])
    references.update(manifest['icons'].values())
    references.add(manifest['sidebar_action']['default_icon'])
    references.add(manifest['action']['default_icon'])
    for name, file in files.items():
        if file.suffix not in {'.js', '.html', '.css'}:
            continue
        source = file.read_text(encoding='utf-8-sig')
        references.update(re.findall(r'icons/[\w./-]+\.(?:png|svg|webp|jpg|gif)', source))
        references.update(re.findall(r'getURL\([\'"]([^\'"$]+)[\'"]\)', source))
        if file.suffix == '.html':
            references.update(ref for ref in re.findall(r'(?:src|href)=[\'"]([^\'"]+)[\'"]', source)
                              if not ref.startswith(('https:', 'http:', '#', 'data:', 'mailto:')))
    missing = references - files.keys()
    if missing:
        raise ValueError(f'Resources missing from archive: {sorted(missing)}')
    locales = [file for name, file in files.items() if name.startswith('_locales/')]
    baseline = json.loads(files['_locales/en/messages.json'].read_text(encoding='utf-8-sig'))
    for file in locales:
        messages = json.loads(file.read_text(encoding='utf-8-sig'))
        if messages.keys() != baseline.keys():
            raise ValueError(f'Locale key mismatch: {file.parent.name}')
        if not all(item.get('message') for item in messages.values()):
            raise ValueError(f'Empty translation: {file.parent.name}')
    return len(references), len(locales)


def verify_archive(archive, files):
    with ZipFile(archive) as package:
        if set(package.namelist()) != files.keys() or len(package.namelist()) != len(files):
            raise ValueError('Archive file inventory differs from the release sources')
        if package.testzip():
            raise ValueError('Archive CRC verification failed')
        for name, file in files.items():
            if package.read(name) != file.read_bytes():
                raise ValueError(f'Archive content differs from source: {name}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='Verify the existing release without rewriting it')
    args = parser.parse_args()
    files = release_files()
    resources, locales = check_resources(files)
    version = json.loads(files['manifest.json'].read_text(encoding='utf-8-sig'))['version']
    archive = ROOT / f'Workspaces-{version}.zip'
    if not args.check:
        with ZipFile(archive, 'w', compression=ZIP_DEFLATED, compresslevel=9) as package:
            for name, file in files.items():
                package.write(file, name)
    verify_archive(archive, files)
    print(f'{archive.name}: {len(files)} files, {resources} resource references, {locales} locales; verified')


if __name__ == '__main__':
    main()
