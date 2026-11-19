/**
 * The Ionic components the phone's first screen (Home) needs, from
 * @ionic/react. They load with the first route.
 *
 * Everything else comes from `ionic-lazy.tsx`, which loads after the first
 * paint. @ionic/react is one module, so a component imported from it
 * anywhere (even a lazy page) lands in the first route's chunk: import only
 * these few from here.
 */
export {
	IonApp,
	IonButton,
	IonButtons,
	IonContent,
	IonHeader,
	IonItem,
	IonNav,
	IonSearchbar,
	IonTitle,
	IonToolbar,
	setupIonicReact,
} from "@ionic/react";
