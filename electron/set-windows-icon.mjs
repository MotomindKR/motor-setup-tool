import { rcedit } from 'rcedit';

const [executable, icon, version] = process.argv.slice(2);
if (!executable || !icon || !version) throw new Error('Expected executable, icon and version');
await rcedit(executable, {
  icon,
  'file-version': version,
  'product-version': version,
  'version-string': {
    ProductName: 'Motor Setup Tool',
    FileDescription: 'Motor Setup Tool',
    CompanyName: 'Motomind',
  },
});
