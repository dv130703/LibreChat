import { useFormContext, Controller } from 'react-hook-form';
import InputWithLabel from './InputWithLabel';
import { useLocalize } from '~/hooks';

const OllamaConfig = () => {
  const localize = useLocalize();
  const { control } = useFormContext();
  return (
    <form className="flex-wrap">
      <Controller
        name="baseURL"
        control={control}
        render={({ field }) => (
          <InputWithLabel
            id="baseURL"
            {...field}
            label={localize('com_endpoint_config_ollama_url')}
            subLabel={localize('com_endpoint_config_ollama_url_sublabel')}
            labelClassName="mb-1"
          />
        )}
      />
    </form>
  );
};

export default OllamaConfig;
